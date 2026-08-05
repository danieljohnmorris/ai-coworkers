// Integration test: run one full tick against fake LLM + fake sensor + fake action.
// Verifies the tick pipeline actually threads perception → deliberation →
// boundary check → action → log without needing external APIs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tick } from "../src/runtime/tick.ts";
import { openEvents, Log } from "../src/runtime/log.ts";
import { openMemory } from "../src/runtime/memory.ts";
import { openHygiene } from "../src/runtime/hygiene.ts";
import { openSemantic } from "../src/runtime/semantic.ts";
import { openEntities } from "../src/runtime/entities.ts";
import { openInbox } from "../src/runtime/inbox.ts";
import { initEpisodic } from "../src/runtime/episodic.ts";
import { ToolRegistry, type ToolDef } from "../src/runtime/tools.ts";
import { loadRole } from "../src/runtime/role.ts";
import { _resetForTests as resetCircuit } from "../src/runtime/circuit.ts";
import { stubLLM, type StubbedLLM } from "./fixtures.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let llm: StubbedLLM;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tick-"));
  resetCircuit();
  llm = stubLLM();
});
afterEach(() => {
  llm.reset();
  rmSync(dir, { recursive: true, force: true });
});

function seedRole(name: string) {
  const roleDir = join(dir, name, "role");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "ROLE.md"), "You are a test coworker.");
  writeFileSync(join(roleDir, "RESPONSIBILITIES.md"), "- Do things.");
  writeFileSync(join(roleDir, "AUTHORITY.md"), "Decide alone: comment.");
  writeFileSync(join(roleDir, "BOUNDARIES.md"), "## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
  writeFileSync(join(roleDir, "RITUALS.md"), "## Tempo\n- keep quiet");
  writeFileSync(join(roleDir, "RELATIONSHIPS.md"), "-");
  writeFileSync(join(roleDir, "TOOLS.md"), "- fake");
  writeFileSync(join(roleDir, "WORKSPACE.md"), "-");
  return loadRole(dir, name);
}

function tools(actionSpy: (input: unknown) => void): ToolRegistry {
  const r = new ToolRegistry();
  const sensor: ToolDef = {
    name: "fake.signal", kind: "sensor",
    description: "", inputSchema: { type: "object" },
    handler: async () => ({ n: 1 }),
  };
  const action: ToolDef = {
    name: "fake.comment", kind: "action",
    description: "post a fake comment", inputSchema: { type: "object" },
    handler: async (i) => { actionSpy(i); return { ok: true }; },
  };
  r.register(sensor); r.register(action);
  return r;
}

function ctx(role: any, tr: ToolRegistry) {
  const stateDir = join(dir, role.name, "state");
  mkdirSync(stateDir, { recursive: true });
  const events = openEvents(join(stateDir, "events.db"));
  initEpisodic(events);
  return {
    role, events,
    memory: openMemory(join(stateDir, "memory.db")),
    hygiene: openHygiene(join(stateDir, "hygiene.db")),
    semantic: openSemantic(join(stateDir, "memory", "MEMORY.md")),
    entities: openEntities(join(stateDir, "entities")),
    inbox: openInbox(join(stateDir, "inbox.md")),
    tools: tr,
    llm: llm.llm,
    dryRun: true,
    log: new Log(events, role.name),
  };
}

describe("tick pipeline", () => {
  it("noop when the model chooses noop", async () => {
    const role = seedRole("t");
    let called = 0;
    const tr = tools(() => called++);
    llm.respondWith({ action: "noop", reason: "quiet" });
    await tick(ctx(role, tr));
    expect(called).toBe(0);
  });

  it("routes a call action through boundary check and to the handler", async () => {
    const role = seedRole("t");
    let seen: unknown = null;
    const tr = tools((input) => { seen = input; });
    llm.respondWith({ action: "call", tool: "fake.comment", input: { body: "hi" }, reason: "test" });
    await tick(ctx(role, tr));
    expect(seen).toEqual({ body: "hi" });
  });

  it("blocks a call whose input mentions a forbidden target", async () => {
    const role = seedRole("t");
    let called = 0;
    const tr = tools(() => called++);
    llm.respondWith({ action: "call", tool: "fake.comment", input: { body: "expose secret" }, reason: "test" });
    await tick(ctx(role, tr));
    expect(called).toBe(0); // boundary block prevented execution
  });

  it("skips the LLM call when over daily budget", async () => {
    const role = seedRole("t");
    const c = ctx(role, tools(() => {}));
    // Seed 500 deliberate events for today
    for (let i = 0; i < 500; i++) {
      c.events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
        .run(new Date().toISOString(), "t", "deliberate", "{}");
    }
    // If the LLM WERE called it would 500 (nothing queued); expect no error
    await tick(c);
    // deliberate count didn't grow (no new deliberate event this tick)
    const n = (c.events.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='deliberate'").get() as any).n;
    expect(n).toBe(500);
  });
});
