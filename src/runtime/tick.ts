// The game clock. Each tick:
//   1. sense    — run every allowed sensor, capture results
//   2. perceive — assemble perception object
//   3. deliberate — LLM decides act or noop
//   4. act      — if act, boundary-check then execute one tool
//   5. record   — log everything, hygiene sweep
//   6. sleep    — until next scheduled tick or event

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deliberate, type Perception } from "./deliberate.ts";
import type { LLMConfig } from "./llm.ts";
import { checkAction } from "./boundaries.ts";
import type { Role } from "./role.ts";
import { sweep, activeCount } from "./hygiene.ts";
import { pendingPromises, recentRollups } from "./memory.ts";
import { Log } from "./log.ts";
import type { ToolRegistry } from "./tools.ts";
import { readTempo, readBudget, extractTempoGuidance } from "./tempo.ts";
import { getCached, setCached, minInterval, invalidatePrefix } from "./sensor-cache.ts";
import type { SemanticMemory } from "./semantic.ts";
import { runDue, type RitualDef } from "./rituals.ts";
import { loadRituals, type RitualAction, type RitualSpec } from "./rituals_loader.ts";
import { dreamOnce } from "./reflect.ts";
import { auditRoleDocs } from "./role_audit.ts";
import { filterEnvForTool } from "./credentials.ts";
import { triage } from "./triage.ts";
import { rateLimitRemaining, recordRateLimit, retryAfterFrom, activeRateLimits } from "./rate_limits.ts";
import { maskDeep, unmask, newMaskTable } from "./pii_mask.ts";
import { writeJournal } from "./journal.ts";
import { matchIntents } from "./intents.ts";
import { tailHighlights } from "./log.ts";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import type { EntityStore } from "./entities.ts";
import type { Inbox } from "./inbox.ts";
import { renderReactions, type Reactions } from "./reactions.ts";
import { checkBudget, extractCallCap, extractWindowCap, extractWindowMinutes } from "./budget.ts";
import { shouldSkip as circuitShouldSkip, recordError as circuitError, recordSuccess as circuitOk } from "./circuit.ts";
import { compactRecentActions, truncateSensorPayloads } from "./working.ts";
import { retryAsync } from "./retry.ts";
import { validateInput } from "./validate.ts";

export interface TickContext {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  hygiene: DatabaseSync;
  semantic: SemanticMemory;
  entities: EntityStore;
  inbox: Inbox;
  reactions: Reactions;
  tools: ToolRegistry;
  llm: LLMConfig;
  triageLlm?: LLMConfig;       // AIC-47 — optional cheap-first preflight
  dryRun: boolean;
  log: Log;
  forceDeliberate?: boolean;   // set by external wake — bypass quiet gate this tick
  // Per-coworker env. When omitted, falls back to process.env for backwards
  // compatibility with existing tests. Production callers should pass a
  // scoped env built by loadCoworkerEnv() so multiple coworkers in one
  // repo don't share secrets.
  env?: NodeJS.ProcessEnv;
}

export interface TickOutcome {
  quiet: boolean;         // true if we short-circuited before deliberation (zero LLM cost)
  didNoAction?: boolean;  // true if we deliberated but chose noop (LLM ran, but no side effect)
  pace?: "faster" | "hold" | "slower";
}

export async function tick(ctx: TickContext): Promise<TickOutcome> {
  const tStart = Date.now();
  ctx.log.event("tick.start", { ts: new Date().toISOString() });
  ctx.log.stream(`tick →`);

  // 0. budget gate — cheap check, cut expensive LLM call if we're over cap
  const cap = extractCallCap(ctx.role.docs.BOUNDARIES);
  const windowCap = extractWindowCap(ctx.role.docs.BOUNDARIES);
  const windowMinutes = extractWindowMinutes(ctx.role.docs.BOUNDARIES);
  const budgetGate = checkBudget(ctx.events, cap, windowCap, windowMinutes);
  if (budgetGate.overDailyBudget || budgetGate.overWindowBudget) {
    const which = budgetGate.overWindowBudget ? "WINDOW" : "DAILY";
    const detail = budgetGate.overWindowBudget
      ? `${budgetGate.callsInWindow}/${budgetGate.windowCap} in ${budgetGate.windowMinutes}min window`
      : `${budgetGate.callsToday}/${budgetGate.dailyCap} today`;
    ctx.log.event("note", { message: "over_budget", which, ...budgetGate });
    ctx.log.highlight(`OVER ${which} BUDGET (${detail}) — sleeping`);
    await finish(ctx, tStart);
    return { quiet: true, pace: "slower" };
  }

  // 1. sense (with per-sensor min-interval caching + circuit breaker)
  const allowedTools = new Set(ctx.tools.scopedTo(ctx.role.docs.TOOLS));
  const sensors: Perception["sensors"] = [];
  const nowMs = Date.now();
  for (const s of ctx.tools.sensors()) {
    if (!allowedTools.has(s.name) && !allowedNamespace(allowedTools, s.name)) continue;
    if (circuitShouldSkip(s.name, nowMs)) {
      ctx.log.event("sensor.error", { name: s.name, error: "quarantined" });
      continue;
    }
    // AIC-62 — external rate-limit awareness. Skip sensors whose service
    // told us to back off; ramming a 429'd service just deepens the hole.
    const rlRemaining = rateLimitRemaining(s.name, nowMs);
    if (rlRemaining > 0) {
      ctx.log.event("sensor.error", { name: s.name, error: `rate-limited (${rlRemaining}s remaining)` });
      continue;
    }
    const cached = getCached(s.name, nowMs);
    if (cached !== undefined) {
      sensors.push({ name: s.name, result: cached });
      ctx.log.event("sensor.read", { name: s.name, ok: true, cached: true });
      continue;
    }
    try {
      const result = await s.handler({}, {
        coworker: ctx.role.name,
        dryRun: ctx.dryRun,
        env: filterEnvForTool(ctx.env ?? process.env, s.requiresCreds),
      });
      if (minInterval(s.name) > 0) setCached(s.name, result, nowMs);
      sensors.push({ name: s.name, result });
      ctx.log.event("sensor.read", { name: s.name, ok: true, cached: false });
      circuitOk(s.name);
    } catch (err) {
      sensors.push({ name: s.name, result: null, error: String(err) });
      ctx.log.event("sensor.error", { name: s.name, error: String(err) });
      // AIC-62 — detect 429/rate-limit in the error and record the
      // cooldown so subsequent sensor + action calls skip this prefix.
      // Rely on the string form of the error since tools throw a mix of
      // Error and plain-string; both include the HTTP status when it's
      // an upstream response failure.
      const msg = String(err);
      if (/\b429\b|rate[- ]?limit/i.test(msg)) {
        const secMatch = msg.match(/retry.after[^\d]*(\d+)/i);
        recordRateLimit(s.name, secMatch ? Number(secMatch[1]) : undefined, msg.slice(0, 200));
        ctx.log.event("note", { sensor: s.name, rate_limited: true });
      }
      const c = circuitError(s.name, nowMs);
      if (c.quarantined) ctx.log.event("note", { sensor: s.name, quarantined: true });
    }
  }

  // Working-memory trim: truncate any single verbose sensor result.
  let trimmedSensors = truncateSensorPayloads(sensors);

  // AIC-82 — reversible identifier masking. Opt-in via PII_MASK=1 in the
  // coworker env. When on, cloud identifiers (cluster names, pods, account
  // IDs, IP addresses, UUIDs) get replaced with stable per-tick tokens
  // before landing in the deliberate prompt; decision.input is unmasked
  // before the tool handler runs. LLM sees <K8S_POD_1>, tool sees the
  // real pod name — leak is scoped to one tick's worth of context.
  const piiMaskOn = (ctx.env ?? process.env).PII_MASK === "1";
  const maskTable = piiMaskOn ? newMaskTable() : null;
  if (maskTable) {
    trimmedSensors = trimmedSensors.map((s) => {
      if (s.error) return s;
      const { masked } = maskDeep(s.result, maskTable);
      return { ...s, result: masked };
    });
  }

  // 2. perceive
  const recentActions = (
    ctx.events
      .prepare(
        `SELECT ts, payload FROM events
         WHERE kind = 'action' ORDER BY id DESC LIMIT 10`
      )
      .all() as { ts: string; payload: string }[]
  )
    .map((r) => {
      const p = JSON.parse(r.payload);
      return { ts: r.ts, tool: p.tool, input: p.input, outcome: p.outcome ?? "ok" };
    })
    .reverse();

  const promises = pendingPromises(ctx.memory, new Date()).map((p) => ({
    id: p.id,
    trigger: p.trigger,
    action: p.action,
    fire_after: p.fire_after,
  }));

  const resources = ["worktree", "subprocess", "scratch_dir"].map((k) => ({
    kind: k,
    count: activeCount(ctx.hygiene, k as any),
  }));

  const tempo = readTempo(ctx.events);
  const budget = readBudget(ctx.events);
  const tempoGuidance = extractTempoGuidance(ctx.role.docs.RITUALS);

  // Perception-change hash: if sensors + promises are unchanged since last
  // tick, note it so the model (and future gates) can see quiescence.
  const changeInput = JSON.stringify({ sensors, promises });
  const changeHash = createHash("sha1").update(changeInput).digest("hex").slice(0, 12);
  const prevRow = ctx.events
    .prepare(`SELECT ts, payload FROM events WHERE kind = 'perception.hash' ORDER BY id DESC LIMIT 1`)
    .get() as { ts: string; payload: string } | undefined;
  const prev = prevRow ? JSON.parse(prevRow.payload) : null;
  const perceptionUnchanged = prev && prev.hash === changeHash;
  const secSinceChange = perceptionUnchanged && prev?.ts
    ? Math.floor((Date.now() - Date.parse(prev.ts)) / 1000)
    : 0;
  ctx.log.event("perception.hash", { hash: changeHash, ts: perceptionUnchanged ? prev.ts : new Date().toISOString() });
  tempo.secondsSinceLastPerceptionChange = secSinceChange;

  // Quiet shortcut — skip deliberation ONLY when there is genuinely nothing
  // to do. "Nothing changed" is not the same as "no work" — a stable backlog
  // of untagged issues is unchanged perception but real work pending.
  const promisesDue = promises.length > 0;
  const anyRitualDue = ctx.events
    .prepare(`SELECT ts FROM events WHERE kind = 'ritual.run' ORDER BY id DESC LIMIT 1`)
    .get() ? false : true;
  const hasWork = sensors.some((s) => sensorSuggestsWork(s.result));
  if (perceptionUnchanged && !promisesDue && !anyRitualDue && !hasWork && !ctx.forceDeliberate) {
    ctx.log.event("note", { quiet: true, secSinceChange });
    ctx.log.stream(`quiet — nothing new for ${secSinceChange}s, no LLM call`);
    sweep(ctx.hygiene, ctx.role.limits, ctx.log);
    await finish(ctx, tStart);
    return { quiet: true };
  }

  // Working-memory trim: bound the recent-actions blob.
  const { compact: compactActions } = compactRecentActions(recentActions);

  const highlightsPath = join(ctx.role.dir, "..", "state", "highlights.log");
  const highlightsTail = tailHighlights(highlightsPath, 20);

  const thoughtRows = ctx.events
    .prepare(
      `SELECT ts, payload FROM events WHERE kind = 'deliberate' ORDER BY id DESC LIMIT 8`
    )
    .all() as { ts: string; payload: string }[];
  const recentThoughts = thoughtRows
    .reverse()
    .map((r) => {
      try {
        const p = JSON.parse(r.payload);
        return p.thoughts ? `[${r.ts.slice(11, 16)}] ${p.thoughts}` : "";
      } catch { return ""; }
    })
    .filter(Boolean)
    .join("\n");

  const perception: Perception = {
    now: new Date().toISOString(),
    sensors: trimmedSensors,
    recentActions: compactActions,
    pendingPromises: promises,
    resources,
    rollups: recentRollups(ctx.memory, 3),
    tempo,
    budget,
    tempoGuidance,
    highlightsTail,
    recentThoughts,
    inboxUnread: ctx.inbox.unread(),
    reactionsUnread: renderReactions(ctx.reactions.unread()),
    rateLimits: activeRateLimits(),
  };
  // Once perception is built the unread notes are marked as read so a note
  // is presented once (highlighted for the model that turn) and doesn't
  // permanently dominate future context.
  if (perception.inboxUnread) {
    ctx.log.highlight(`📬 note from manager: ${perception.inboxUnread.slice(0, 200)}`);
    ctx.inbox.markAllRead();
  }
  if (perception.reactionsUnread) {
    ctx.log.highlight(`🫱 reactions from manager:\n${perception.reactionsUnread.slice(0, 400)}`);
    ctx.reactions.markAllRead();
  }

  // AIC-47 — optional cheap-first triage. When ctx.triageLlm is set,
  // ask a small model whether there's anything worth acting on. If not,
  // skip the expensive deliberate entirely. forceDeliberate (external
  // wake) bypasses the triage — humans asked for a tick, honour it.
  if (ctx.triageLlm && !ctx.forceDeliberate) {
    const t = await triage(ctx.triageLlm, perception);
    if (!t.act) {
      ctx.log.event("tick.triage-skip", { reason: t.reason.slice(0, 200) });
      ctx.log.stream(`triage-skip — ${t.reason.slice(0, 100)}`);
      sweep(ctx.hygiene, ctx.role.limits, ctx.log);
      await finish(ctx, tStart);
      return { quiet: true };
    }
    ctx.log.event("tick.triage-act", { reason: t.reason.slice(0, 200) });
  }

  // 3. deliberate
  const availableActions = ctx.tools
    .actions()
    .filter((a) => allowedTools.has(a.name) || allowedNamespace(allowedTools, a.name));

  // Augment the cached role prompt with the current semantic memory + any
  // entity cards mentioned in this tick's perception.
  const semanticBody = ctx.semantic.read().trim();
  const perceptionBlob = JSON.stringify({ sensors, promises });
  const { people, projects } = ctx.entities.detect(perceptionBlob);
  // AIC-55 — include RELATIONSHIP edges for every detected entity, so
  // the model sees not just "Dan (person card)" but "Dan works_on ILO,
  // reviews CS". Cap the per-entity edge list so a highly-connected
  // entity can't blow the prompt.
  const edgeSnippet = (ref: { kind: "person" | "project"; key: string }): string => {
    const edges = ctx.entities.edgesFor(ref);
    if (!edges.length) return "";
    const lines = edges.slice(0, 8).map((e) => {
      const other = e.from.kind === ref.kind && e.from.key === ref.key ? e.to : e.from;
      const arrow = e.from.kind === ref.kind && e.from.key === ref.key ? "→" : "←";
      return `- ${arrow} ${e.type} ${other.kind}:${other.key}${e.note ? ` — ${e.note}` : ""}`;
    });
    return `\n\n### relationships\n${lines.join("\n")}`;
  };
  const entityCards = [
    ...people.map((h) => `## person: ${h}\n${ctx.entities.readPerson(h).trim()}${edgeSnippet({ kind: "person", key: h })}`),
    ...projects.map((k) => `## project: ${k}\n${ctx.entities.readProject(k).trim()}${edgeSnippet({ kind: "project", key: k })}`),
  ].filter((s) => s.split("\n").length > 1).join("\n\n");

  let augmentedPrompt = ctx.role.systemPrompt;
  if (semanticBody) augmentedPrompt += `\n\n---\n\n# MEMORY (what you have learned)\n\n${semanticBody}`;
  if (entityCards) augmentedPrompt += `\n\n---\n\n# ENTITIES (mentioned in current perception)\n\n${entityCards}`;
  const augmentedRole = augmentedPrompt === ctx.role.systemPrompt ? ctx.role : { ...ctx.role, systemPrompt: augmentedPrompt };

  // 3+4. deliberate → act — CHAINED. The model may call several tools in one
  // tick, each one seeing the previous outcome, until it noops with reason
  // "done" or we hit the cap. This is the Hermes/Eliza turn-based pattern.
  const maxToolsPerTick = Number(process.env.MAX_TOOLS_PER_TICK ?? 8);
  const priorSteps: { tool: string; input: unknown; outcome: unknown }[] = [];
  let ranAnyAction = false;
  let lastPace: "faster" | "hold" | "slower" | undefined;

  for (let step = 0; step < maxToolsPerTick; step++) {
    let decision: any;
    try {
      decision = await deliberate(augmentedRole, perception, availableActions, ctx.llm, priorSteps);
      lastPace = decision.pace ?? lastPace;
      // AIC-45 — capture token usage per deliberate call.
      const usage = (decision as any).usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      ctx.log.event("deliberate", {
        choice: decision.action,
        reason: decision.reason,
        thoughts: decision.thoughts ?? null,
        pace: decision.pace ?? null,
        step,
        model: ctx.llm.model,
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
      });
      if (decision.thoughts) {
        ctx.log.highlight(`💭 ${decision.thoughts.slice(0, 400)}`);
      }
      if (decision.rawOutput) {
        ctx.log.event("deliberate.rawoutput", { raw: String(decision.rawOutput).slice(0, 4000) });
      }
    } catch (err) {
      ctx.log.event("deliberate.error", { error: String(err) });
      ctx.log.highlight(`deliberate error: ${err}`);
      break;
    }

    if (decision.action === "noop") {
      ctx.log.stream(`noop — ${decision.reason.slice(0, 100)}`);
      break;
    }

    const tool = ctx.tools.get(decision.tool);
    if (!tool) {
      ctx.log.event("action.error", { tool: decision.tool, error: "not registered" });
      ctx.log.highlight(`✗ ${decision.tool} not registered`);
      break;
    }
    const decisionCtx = { coworker: ctx.role.name, dryRun: ctx.dryRun, env: filterEnvForTool(ctx.env ?? process.env, tool.requiresCreds) };
    // AIC-43 — validate input against the tool's declared schema. Failure
    // is fed back as a chained-step outcome (not fatal) so the model can
    // correct itself on the next step.
    const v = validateInput(tool.inputSchema, decision.input);
    if (!v.ok) {
      ctx.log.event("action.error", { tool: tool.name, error: `schema: ${v.errors.join("; ")}`, input: decision.input });
      ctx.log.highlight(`✗ ${tool.name} bad input: ${v.errors[0]}`);
      priorSteps.push({ tool: tool.name, input: decision.input, outcome: { error: `input failed schema validation: ${v.errors.join("; ")}` } });
      continue;
    }
    const b = checkAction(ctx.role, tool, decision.input, decisionCtx);
    if (!b.allowed) {
      ctx.log.event("boundary.block", { tool: tool.name, reason: b.reason, input: decision.input });
      ctx.log.highlight(`✗ boundary: ${b.reason}`);
      break;
    }
    ctx.log.event("action", {
      tool: tool.name,
      input: decision.input,
      reason: decision.reason,
      dryRun: ctx.dryRun,
      step,
    });
    // Repeat-action guard: refuse to call the identical (tool, input) pair
    // more than once in a single tick. Prevents the model from thrashing on
    // a specific ticket and never moving on.
    const sig = `${tool.name}:${JSON.stringify(decision.input)}`;
    if (priorSteps.some((s) => `${s.tool}:${JSON.stringify(s.input)}` === sig)) {
      ctx.log.event("action.error", { tool: tool.name, error: "repeat guard", input: decision.input });
      ctx.log.highlight(`✗ repeat guard: ${tool.name} with same input already tried this tick — move on`);
      priorSteps.push({ tool: tool.name, input: decision.input, outcome: { error: "duplicate call this tick — pick a different action or different input" } });
      continue;
    }

    // AIC-62 — refuse actions to a rate-limited service instead of racking
    // up more 429s. Feed the block back as an outcome so the model can
    // pick a different action.
    const rlRemaining = rateLimitRemaining(tool.name);
    if (rlRemaining > 0) {
      const outcome = { error: `rate-limited: ${tool.name.split(".")[0]} is backed off for ${rlRemaining}s more; pick a different service or noop` };
      ctx.log.event("action.error", { tool: tool.name, error: "rate-limited", step });
      ctx.log.highlight(`✗ ${tool.name} skipped: rate-limited (${rlRemaining}s)`);
      priorSteps.push({ tool: tool.name, input: decision.input, outcome });
      continue;
    }

    let outcome: unknown;
    try {
      // AIC-82 — unmask decision.input before it hits the tool handler.
      // The LLM has been reasoning with masked tokens; the tool needs the
      // real identifiers to make actual API calls.
      const runInput = maskTable
        ? JSON.parse(unmask(JSON.stringify(decision.input), maskTable))
        : decision.input;
      // AIC-46 — retry transient failures (5xx, 429, ECONNRESET) before giving up.
      outcome = await retryAsync(() => tool.handler(runInput, decisionCtx));
      ctx.log.highlight(`→ ${tool.name}${ctx.dryRun ? " (dry-run)" : ""}: ${JSON.stringify(decision.input).slice(0, 120)}`);
      ctx.log.event("note", { tool: tool.name, outcome, step });
      ranAnyAction = true;
      // Any successful write to an external system means cached reads of that
      // system are stale. Invalidate so the next perception reflects reality.
      const prefix = tool.name.split(".")[0] + ".";
      if (!ctx.dryRun) invalidatePrefix(prefix);
    } catch (err) {
      outcome = { error: String(err) };
      ctx.log.event("action.error", { tool: tool.name, error: String(err), step });
      ctx.log.highlight(`✗ ${tool.name} failed: ${err}`);
      // AIC-62 — same 429 detection as the sensor path.
      const msg = String(err);
      if (/\b429\b|rate[- ]?limit/i.test(msg)) {
        const secMatch = msg.match(/retry.after[^\d]*(\d+)/i);
        recordRateLimit(tool.name, secMatch ? Number(secMatch[1]) : undefined, msg.slice(0, 200));
      }
      // Let the model see the failure and decide whether to try again or bail.
    }
    priorSteps.push({ tool: tool.name, input: decision.input, outcome });
  }

  if (priorSteps.length >= maxToolsPerTick) {
    ctx.log.highlight(`cap: ${maxToolsPerTick} tool calls reached this tick`);
  }

  // 5. record + hygiene + intent matcher
  sweep(ctx.hygiene, ctx.role.limits, ctx.log);
  const firedPromises = matchIntents(ctx.memory, ctx.events);
  for (const f of firedPromises) {
    ctx.log.event("promise.fire", { id: f.id, trigger: f.trigger, action: f.action, matched: f.matchedEvent });
    ctx.log.highlight(`⏰ promise fired: ${f.action.slice(0, 100)}`);
  }

  // 6. rituals — cheap check; only fires when due, at most one per tick.
  // Ritual list is declarative: role/rituals/*.json files loaded on each
  // tick (cheap; a coworker can hot-edit its rituals). Falls back to
  // built-in defaults if the dir is absent — see rituals_loader.ts.
  const { specs: ritualSpecs, errors: ritualErrors } = loadRituals(
    join(ctx.role.dir, "rituals"),
  );
  for (const e of ritualErrors) ctx.log.event("note", { rituals_loader: "error", detail: e });

  const rituals: RitualDef[] = ritualSpecs.map((spec) => ({
    name: spec.name,
    cadence: spec.cadence,
    run: async () => { await dispatchRitual(spec.action, ctx); },
  }));
  const fired = await runDue(rituals, ctx.events, ctx.role.name);
  if (fired.length) ctx.log.highlight(`ritual: ${fired.map((f) => f.name).join(", ")}`);

  await finish(ctx, tStart);
  // Tick was NOT quiet if we got this far — we ran deliberation.
  return { quiet: false, didNoAction: !ranAnyAction, pace: lastPace };
}

async function finish(ctx: TickContext, tStart: number): Promise<void> {
  ctx.log.event("tick.end", { duration_ms: Date.now() - tStart });
}

function allowedNamespace(allowed: Set<string>, toolName: string): boolean {
  for (const a of allowed) {
    if (toolName === a || toolName.startsWith(a + ".")) return true;
  }
  return false;
}

// Dispatch a ritual-action name to its implementation. Kept centralised
// so `rituals_loader.KNOWN_ACTIONS` is the source of truth for which
// strings are valid in a role/rituals/*.json declaration.
async function dispatchRitual(action: RitualAction, ctx: TickContext): Promise<void> {
  const stateDir = join(ctx.role.dir, "..", "state");
  switch (action) {
    case "reflect":
      await dreamOnce({
        role: ctx.role,
        events: ctx.events,
        memory: ctx.memory,
        semantic: ctx.semantic,
        llm: ctx.llm,
        log: ctx.log,
      });
      return;

    case "journal":
      await writeJournal({
        role: ctx.role,
        events: ctx.events,
        journalDir: join(stateDir, "journal"),
        llm: ctx.llm,
        log: ctx.log,
      });
      return;

    case "role_audit": {
      const result = auditRoleDocs({
        roleDir: ctx.role.dir,
        snapshotDir: join(stateDir, "audit", "snapshots"),
        findingsLog: join(stateDir, "audit", "findings.log"),
      });
      const criticals = result.findings.filter((f) => f.severity === "critical");
      const warns = result.findings.filter((f) => f.severity === "warn");
      if (criticals.length === 0) {
        if (warns.length) ctx.log.event("note", { audit: "role_docs", warns: warns.length });
        return;
      }
      const summary = criticals.map((c) => `- **${c.doc}.md**: ${c.message}`).join("\n");
      ctx.log.highlight(`🚨 role.audit: ${criticals.length} critical finding(s) — see state/audit/findings.log`);
      const questionsPath = join(stateDir, "questions.md");
      try { mkdirSync(dirname(questionsPath), { recursive: true }); } catch { /* noop */ }
      const block =
        `## ${new Date().toISOString()} — from ${ctx.role.name} (role.audit)\n` +
        `**Q:** My role docs changed in ways that look suspicious. Please review and either revert or accept via \`bin/audit-accept.sh ${ctx.role.name}\`:\n\n${summary}\n\n` +
        `**A:** _(unanswered)_\n\n`;
      try { appendFileSync(questionsPath, block); } catch { /* noop */ }
      return;
    }

    case "health_snapshot": {
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const rows = ctx.events
        .prepare(`SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind`)
        .all(hourAgo) as { kind: string; n: number }[];
      const summary = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
      ctx.log.event("note", { snapshot: "hourly_health", counts: summary });
      return;
    }
  }
}

// Heuristic: does a sensor's result look like it contains actionable work?
// True if it's an object with any non-empty array field (issues, mentions,
// prs, replies, etc.). Deliberately conservative — false positives cost one
// LLM call; false negatives silently strand backlogs.
function sensorSuggestsWork(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  for (const v of Object.values(result as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}
