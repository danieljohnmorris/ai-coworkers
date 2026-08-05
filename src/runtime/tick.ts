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
import { getCached, setCached, minInterval } from "./sensor-cache.ts";
import type { SemanticMemory } from "./semantic.ts";
import { runDue, type RitualDef } from "./rituals.ts";
import { dreamOnce } from "./reflect.ts";
import { writeJournal } from "./journal.ts";
import { tailHighlights } from "./log.ts";
import { join } from "node:path";
import type { EntityStore } from "./entities.ts";
import { checkBudget, extractCallCap } from "./budget.ts";
import { shouldSkip as circuitShouldSkip, recordError as circuitError, recordSuccess as circuitOk } from "./circuit.ts";
import { compactRecentActions, truncateSensorPayloads } from "./working.ts";

export interface TickContext {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  hygiene: DatabaseSync;
  semantic: SemanticMemory;
  entities: EntityStore;
  tools: ToolRegistry;
  llm: LLMConfig;
  dryRun: boolean;
  log: Log;
  forceDeliberate?: boolean;   // set by external wake — bypass quiet gate this tick
}

export interface TickOutcome {
  quiet: boolean;   // perception unchanged, no promise/ritual due, no LLM call made
}

export async function tick(ctx: TickContext): Promise<TickOutcome> {
  const tStart = Date.now();
  ctx.log.event("tick.start", { ts: new Date().toISOString() });
  ctx.log.stream(`tick →`);

  // 0. budget gate — cheap check, cut expensive LLM call if we're over cap
  const cap = extractCallCap(ctx.role.docs.BOUNDARIES);
  const budgetGate = checkBudget(ctx.events, cap);
  if (budgetGate.overBudget) {
    ctx.log.event("note", { message: "over_budget", ...budgetGate });
    ctx.log.highlight(`OVER BUDGET (${budgetGate.callsToday}/${budgetGate.cap}) — sleeping ${budgetGate.minutesUntilReset}m until reset`);
    await finish(ctx, tStart);
    return { quiet: true };
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
        env: process.env,
      });
      if (minInterval(s.name) > 0) setCached(s.name, result, nowMs);
      sensors.push({ name: s.name, result });
      ctx.log.event("sensor.read", { name: s.name, ok: true, cached: false });
      circuitOk(s.name);
    } catch (err) {
      sensors.push({ name: s.name, result: null, error: String(err) });
      ctx.log.event("sensor.error", { name: s.name, error: String(err) });
      const c = circuitError(s.name, nowMs);
      if (c.quarantined) ctx.log.event("note", { sensor: s.name, quarantined: true });
    }
  }

  // Working-memory trim: truncate any single verbose sensor result.
  const trimmedSensors = truncateSensorPayloads(sensors);

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

  // Quiet shortcut — no perception change, no promises due, no due
  // ritual → skip deliberation entirely. Zero LLM cost. This is the big
  // idle-cost win.
  const promisesDue = promises.length > 0;
  const anyRitualDue = ctx.events
    .prepare(
      `SELECT ts FROM events WHERE kind = 'ritual.run' ORDER BY id DESC LIMIT 1`
    ).get() ? false : true;  // conservative: if we've never run a ritual, fall through
  if (perceptionUnchanged && !promisesDue && !anyRitualDue && !ctx.forceDeliberate) {
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
  };

  // 3. deliberate
  const availableActions = ctx.tools
    .actions()
    .filter((a) => allowedTools.has(a.name) || allowedNamespace(allowedTools, a.name));

  // Augment the cached role prompt with the current semantic memory + any
  // entity cards mentioned in this tick's perception.
  const semanticBody = ctx.semantic.read().trim();
  const perceptionBlob = JSON.stringify({ sensors, promises });
  const { people, projects } = ctx.entities.detect(perceptionBlob);
  const entityCards = [
    ...people.map((h) => `## person: ${h}\n${ctx.entities.readPerson(h).trim()}`),
    ...projects.map((k) => `## project: ${k}\n${ctx.entities.readProject(k).trim()}`),
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

  for (let step = 0; step < maxToolsPerTick; step++) {
    let decision: any;
    try {
      decision = await deliberate(augmentedRole, perception, availableActions, ctx.llm, priorSteps);
      ctx.log.event("deliberate", {
        choice: decision.action,
        reason: decision.reason,
        thoughts: decision.thoughts ?? null,
        step,
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
    const decisionCtx = { coworker: ctx.role.name, dryRun: ctx.dryRun, env: process.env };
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
    let outcome: unknown;
    try {
      outcome = await tool.handler(decision.input, decisionCtx);
      ctx.log.highlight(`→ ${tool.name}${ctx.dryRun ? " (dry-run)" : ""}: ${JSON.stringify(decision.input).slice(0, 120)}`);
      ctx.log.event("note", { tool: tool.name, outcome, step });
      ranAnyAction = true;
    } catch (err) {
      outcome = { error: String(err) };
      ctx.log.event("action.error", { tool: tool.name, error: String(err), step });
      ctx.log.highlight(`✗ ${tool.name} failed: ${err}`);
      // Let the model see the failure and decide whether to try again or bail.
    }
    priorSteps.push({ tool: tool.name, input: decision.input, outcome });
  }

  if (priorSteps.length >= maxToolsPerTick) {
    ctx.log.highlight(`cap: ${maxToolsPerTick} tool calls reached this tick`);
  }

  // 5. record + hygiene
  sweep(ctx.hygiene, ctx.role.limits, ctx.log);

  // 6. rituals — cheap check; only fires when due, at most one per tick.
  const rituals: RitualDef[] = [
    {
      name: "reflect.weekly",
      cadence: { kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, // Sun 03:00 UTC
      run: async () => {
        await dreamOnce({
          role: ctx.role,
          events: ctx.events,
          memory: ctx.memory,
          semantic: ctx.semantic,
          llm: ctx.llm,
          log: ctx.log,
        });
      },
    },
    {
      name: "journal.daily",
      cadence: { kind: "daily", hourUTC: 9 },
      run: async () => {
        const journalDir = join(ctx.role.dir, "..", "state", "journal");
        await writeJournal({ role: ctx.role, events: ctx.events, journalDir, llm: ctx.llm, log: ctx.log });
      },
    },
    {
      name: "health.snapshot",
      cadence: { kind: "hourly" },
      run: async () => {
        const hourAgo = new Date(Date.now() - 3600_000).toISOString();
        const rows = ctx.events
          .prepare(
            `SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind`
          )
          .all(hourAgo) as { kind: string; n: number }[];
        const summary = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
        ctx.log.event("note", { snapshot: "hourly_health", counts: summary });
      },
    },
  ];
  const fired = await runDue(rituals, ctx.events, ctx.role.name);
  if (fired.length) ctx.log.highlight(`ritual: ${fired.map((f) => f.name).join(", ")}`);

  await finish(ctx, tStart);
  // Tick was NOT quiet if we got this far — we ran deliberation.
  return { quiet: false };
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
