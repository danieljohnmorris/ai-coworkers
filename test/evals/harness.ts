// test/evals/harness.ts — behaviour-eval scaffolding. Reuses stubLLM +
// the same tick() we ship in production; adds a runScenario() that hides
// the beforeEach boilerplate every scenario would otherwise repeat.
//
// See ./README.md for when to add a scenario.

import { expect, vi } from "vitest";
import { tick, type TickContext } from "../../src/runtime/tick.ts";
import { openEvents, Log } from "../../src/runtime/log.ts";
import { openMemory } from "../../src/runtime/memory.ts";
import { openHygiene } from "../../src/runtime/hygiene.ts";
import { openSemantic } from "../../src/runtime/semantic.ts";
import { openEntities } from "../../src/runtime/entities.ts";
import { openInbox } from "../../src/runtime/inbox.ts";
import { openReactions } from "../../src/runtime/reactions.ts";
import { initEpisodic } from "../../src/runtime/episodic.ts";
import { _resetForTests as resetCircuit } from "../../src/runtime/circuit.ts";
import { ToolRegistry, type ToolDef } from "../../src/runtime/tools.ts";
import { loadRole } from "../../src/runtime/role.ts";
import { stubLLM } from "../fixtures.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScenarioSensor {
  name: string;
  result?: unknown;                  // if set: sensor returns this
  throws?: string;                   // if set: sensor throws Error(this)
}

export interface ScenarioAction {
  name: string;
  handler?: (input: unknown) => unknown | Promise<unknown>;
}

export interface ScenarioSpec {
  // Role docs. Anything omitted gets a minimal working default.
  role?: {
    tools?: string;                  // TOOLS.md body
    boundaries?: string;
    responsibilities?: string;
  };
  sensors?: ScenarioSensor[];
  actions?: ScenarioAction[];
  // Fake LLM: enqueued responses (JSON objects). Consumed in order per
  // deliberate call. If exhausted, the LLM returns `{action:"noop"}`.
  llmSequence?: unknown[];
  // Manager inputs before the first tick.
  inbox?: string;
  reactions?: { verdict: "👍" | "👎"; note?: string }[];
  // Number of ticks to run. Default 1.
  ticks?: number;
  // Assertions run after the last tick.
  expect: (helpers: {
    events: { ts: string; kind: string; payload: unknown }[];
    tickOutcomes: { quiet: boolean; didNoAction?: boolean }[];
    actionCalls: { tool: string; input: unknown }[];
  }) => void;
}

const DEFAULT_ROLE = {
  ROLE: "You are a test coworker.",
  RESPONSIBILITIES: "- Handle things.",
  AUTHORITY: "Decide alone.",
  BOUNDARIES: "## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500",
  RITUALS: "## Tempo\n- keep quiet",
  RELATIONSHIPS: "-",
  TOOLS: "- fake\n- linear\n- github\n- slack\n- memory",
  WORKSPACE: "-",
};

export async function runScenario(spec: ScenarioSpec): Promise<void> {
  resetCircuit();
  const llm = stubLLM();
  const dir = mkdtempSync(join(tmpdir(), "eval-"));

  try {
    const name = "t";
    const roleDir = join(dir, name, "role");
    mkdirSync(roleDir, { recursive: true });
    const docs = { ...DEFAULT_ROLE };
    if (spec.role?.tools) docs.TOOLS = spec.role.tools;
    if (spec.role?.boundaries) docs.BOUNDARIES = spec.role.boundaries;
    if (spec.role?.responsibilities) docs.RESPONSIBILITIES = spec.role.responsibilities;
    for (const [k, v] of Object.entries(docs)) writeFileSync(join(roleDir, `${k}.md`), v);

    const stateDir = join(dir, name, "state");
    mkdirSync(stateDir, { recursive: true });
    const events = openEvents(join(stateDir, "events.db"));
    initEpisodic(events);
    const role = loadRole(dir, name);

    const tools = new ToolRegistry();
    const actionCalls: { tool: string; input: unknown }[] = [];
    for (const s of spec.sensors ?? []) {
      tools.register({
        name: s.name, kind: "sensor", description: `stub ${s.name}`, inputSchema: { type: "object" },
        handler: async () => {
          if (s.throws) throw new Error(s.throws);
          return s.result ?? {};
        },
      });
    }
    for (const a of spec.actions ?? []) {
      const tool: ToolDef = {
        name: a.name, kind: "action", description: `stub ${a.name}`, inputSchema: { type: "object" },
        handler: async (input) => {
          actionCalls.push({ tool: a.name, input });
          return a.handler ? await a.handler(input) : { ok: true };
        },
      };
      tools.register(tool);
    }

    for (const item of spec.llmSequence ?? []) llm.respondWith(item);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const inbox = openInbox(join(stateDir, "inbox.md"));
    const reactions = openReactions(join(stateDir, "reactions.log"));
    if (spec.inbox) writeFileSync(join(stateDir, "inbox.md"), spec.inbox);
    for (const r of spec.reactions ?? []) reactions.append(r);

    const ctx: TickContext = {
      role, events,
      memory: openMemory(join(stateDir, "memory.db")),
      hygiene: openHygiene(join(stateDir, "hygiene.db")),
      semantic: openSemantic(join(stateDir, "memory", "MEMORY.md")),
      entities: openEntities(join(stateDir, "entities")),
      inbox, reactions,
      tools, llm: llm.llm, dryRun: false,
      log: new Log(events, name),
    };

    const outcomes: { quiet: boolean; didNoAction?: boolean }[] = [];
    const N = spec.ticks ?? 1;
    for (let i = 0; i < N; i++) {
      const o = await tick(ctx);
      outcomes.push({ quiet: o.quiet, didNoAction: o.didNoAction });
    }

    const eventRows = events
      .prepare("SELECT ts, kind, payload FROM events ORDER BY id ASC")
      .all() as { ts: string; kind: string; payload: string }[];
    const eventsDecoded = eventRows.map((r) => ({ ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) }));

    spec.expect({ events: eventsDecoded, tickOutcomes: outcomes, actionCalls });
  } finally {
    llm.reset();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Small helper so scenarios can read "did an event of this kind happen?" quickly.
export function count(events: { kind: string }[], kind: string): number {
  return events.filter((e) => e.kind === kind).length;
}
export { expect };
