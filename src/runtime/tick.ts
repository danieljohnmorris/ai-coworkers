// The game clock. Each tick:
//   1. sense    — run every allowed sensor, capture results
//   2. perceive — assemble perception object
//   3. deliberate — LLM decides act or noop
//   4. act      — if act, boundary-check then execute one tool
//   5. record   — log everything, hygiene sweep
//   6. sleep    — until next scheduled tick or event

import type { DatabaseSync } from "node:sqlite";
import { deliberate, type Perception } from "./deliberate.ts";
import type { LLMConfig } from "./llm.ts";
import { checkAction } from "./boundaries.ts";
import type { Role } from "./role.ts";
import { sweep, activeCount } from "./hygiene.ts";
import { pendingPromises, recentRollups } from "./memory.ts";
import { Log } from "./log.ts";
import type { ToolRegistry } from "./tools.ts";

export interface TickContext {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  hygiene: DatabaseSync;
  tools: ToolRegistry;
  llm: LLMConfig;
  dryRun: boolean;
  log: Log;
}

export async function tick(ctx: TickContext): Promise<void> {
  const tStart = Date.now();
  ctx.log.event("tick.start", { ts: new Date().toISOString() });
  ctx.log.stream(`tick →`);

  // 1. sense
  const allowedTools = new Set(ctx.tools.scopedTo(ctx.role.docs.TOOLS));
  const sensors: Perception["sensors"] = [];
  for (const s of ctx.tools.sensors()) {
    if (!allowedTools.has(s.name) && !allowedNamespace(allowedTools, s.name)) continue;
    try {
      const result = await s.handler({}, {
        coworker: ctx.role.name,
        dryRun: ctx.dryRun,
        env: process.env,
      });
      sensors.push({ name: s.name, result });
      ctx.log.event("sensor.read", { name: s.name, ok: true });
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

  const perception: Perception = {
    now: new Date().toISOString(),
    sensors,
    recentActions,
    pendingPromises: promises,
    resources,
    rollups: recentRollups(ctx.memory, 3),
  };

  // 3. deliberate
  const availableActions = ctx.tools
    .actions()
    .filter((a) => allowedTools.has(a.name) || allowedNamespace(allowedTools, a.name));

  let decision;
  try {
    decision = await deliberate(ctx.role, perception, availableActions, ctx.llm);
    ctx.log.event("deliberate", { choice: decision.action, reason: (decision as any).reason });
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
