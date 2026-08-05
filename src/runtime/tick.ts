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

export interface TickContext {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  hygiene: DatabaseSync;
  semantic: SemanticMemory;
  tools: ToolRegistry;
  llm: LLMConfig;
  dryRun: boolean;
  log: Log;
}

export async function tick(ctx: TickContext): Promise<void> {
  const tStart = Date.now();
  ctx.log.event("tick.start", { ts: new Date().toISOString() });
  ctx.log.stream(`tick →`);

  // 1. sense (with per-sensor min-interval caching so we don't hammer APIs)
  const allowedTools = new Set(ctx.tools.scopedTo(ctx.role.docs.TOOLS));
  const sensors: Perception["sensors"] = [];
  const nowMs = Date.now();
  for (const s of ctx.tools.sensors()) {
    if (!allowedTools.has(s.name) && !allowedNamespace(allowedTools, s.name)) continue;
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
    } catch (err) {
      sensors.push({ name: s.name, result: null, error: String(err) });
      ctx.log.event("sensor.error", { name: s.name, error: String(err) });
    }
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

  const perception: Perception = {
    now: new Date().toISOString(),
    sensors,
    recentActions,
    pendingPromises: promises,
    resources,
    rollups: recentRollups(ctx.memory, 3),
    tempo,
    budget,
    tempoGuidance,
  };

  // 3. deliberate
  const availableActions = ctx.tools
    .actions()
    .filter((a) => allowedTools.has(a.name) || allowedNamespace(allowedTools, a.name));

  // Augment the cached role prompt with the current semantic memory. This
  // is the small (<= 2KB) MEMORY.md the coworker maintains for itself.
  const semanticBody = ctx.semantic.read().trim();
  const augmentedRole = semanticBody
    ? { ...ctx.role, systemPrompt: `${ctx.role.systemPrompt}\n\n---\n\n# MEMORY (what you have learned)\n\n${semanticBody}` }
    : ctx.role;

  let decision: any;
  try {
    decision = await deliberate(augmentedRole, perception, availableActions, ctx.llm);
    ctx.log.event("deliberate", { choice: decision.action, reason: decision.reason });
    if (decision.rawOutput) {
      // Parse fail — persist the full raw output for debugging.
      ctx.log.event("deliberate.rawoutput", { raw: String(decision.rawOutput).slice(0, 4000) });
    }
  } catch (err) {
    ctx.log.event("deliberate.error", { error: String(err) });
    ctx.log.stream(`deliberate error: ${err}`);
    await finish(ctx, tStart);
    return;
  }

  // 4. act
  if (decision.action === "noop") {
    ctx.log.stream(`noop — ${decision.reason.slice(0, 100)}`);
  } else {
    const tool = ctx.tools.get(decision.tool);
    if (!tool) {
      ctx.log.event("action.error", { tool: decision.tool, error: "not registered" });
      ctx.log.stream(`✗ ${decision.tool} not registered`);
    } else {
      const decisionCtx = { coworker: ctx.role.name, dryRun: ctx.dryRun, env: process.env };
      const b = checkAction(ctx.role, tool, decision.input, decisionCtx);
      if (!b.allowed) {
        ctx.log.event("boundary.block", { tool: tool.name, reason: b.reason, input: decision.input });
        ctx.log.stream(`✗ boundary: ${b.reason}`);
      } else {
        ctx.log.event("action", {
          tool: tool.name,
          input: decision.input,
          reason: decision.reason,
          dryRun: ctx.dryRun,
        });
        try {
          const outcome = await tool.handler(decision.input, decisionCtx);
          ctx.log.stream(`→ ${tool.name} ${ctx.dryRun ? "(dry-run)" : ""}`);
          ctx.log.event("note", { tool: tool.name, outcome });
        } catch (err) {
          ctx.log.event("action.error", { tool: tool.name, error: String(err) });
          ctx.log.stream(`✗ ${tool.name} failed: ${err}`);
        }
      }
    }
  }

  // 5. record + hygiene
  sweep(ctx.hygiene, ctx.role.limits, ctx.log);

  await finish(ctx, tStart);
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
