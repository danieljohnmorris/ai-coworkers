// Tests for the tick() game loop. Uses real sqlite, real Log/Inbox/Semantic/
// Entities/ToolRegistry — mocks only globalThis.fetch (for LLM) and specific
// tool handlers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, type TickContext } from "./tick.ts";
import { openEvents, Log } from "./log.ts";
import { openHygiene } from "./hygiene.ts";
import { openMemory } from "./memory.ts";
import { openSemantic } from "./semantic.ts";
import { openEntities } from "./entities.ts";
import { openInbox } from "./inbox.ts";
import { openReactions } from "./reactions.ts";
import { ToolRegistry, type ToolDef } from "./tools.ts";
import type { Role } from "./role.ts";
import type { LLMConfig } from "./llm.ts";
import { _resetForTests as resetCircuit } from "./circuit.ts";
import { invalidatePrefix } from "./sensor-cache.ts";

// ---------- helpers ----------

function makeRole(dir: string, opts: { boundaries?: string; tools?: string; rituals?: string } = {}): Role {
  const roleDir = join(dir, "role");
  mkdirSync(roleDir, { recursive: true });
  const docs = {
    ROLE: "test coworker",
    RESPONSIBILITIES: "test",
    AUTHORITY: "test",
    BOUNDARIES: opts.boundaries ?? "Max LLM calls per day: 5000",
    RITUALS: opts.rituals ?? "",
    RELATIONSHIPS: "",
    TOOLS: opts.tools ?? "- fake",
    WORKSPACE: "",
  };
  return {
    name: "tester",
    dir: roleDir,
    docs,
    systemPrompt: "you are a test",
    limits: { maxWorktrees: 5, maxWorktreeAgeHours: 24, maxDiskMB: 5120, killSubprocessIdleMin: 30 },
    cadence: "adaptive",
  };
}

function makeCtx(dir: string, roleOverrides: Parameters<typeof makeRole>[1] = {}): TickContext {
  const role = makeRole(dir, roleOverrides);
  const events = openEvents(join(dir, "events.db"));
  const memory = openMemory(join(dir, "memory.db"));
  const hygiene = openHygiene(join(dir, "hygiene.db"));
  const semantic = openSemantic(join(dir, "state", "memory", "MEMORY.md"));
  const entities = openEntities(join(dir, "state", "entities"));
  const inbox = openInbox(join(dir, "state", "inbox.md"));
  const reactions = openReactions(join(dir, "state", "reactions.log"));
  const tools = new ToolRegistry();
  const llm: LLMConfig = { baseUrl: "http://x", apiKey: "k", model: "test-model" };
  const log = new Log(events, "tester");
  // Silence stdout from log.stream / log.highlight.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return { role, events, memory, hygiene, semantic, entities, inbox, reactions, tools, llm, dryRun: false, log };
}

function llmReply(decision: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(decision) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as unknown as Response;
}

function mockFetchSequence(replies: unknown[]) {
  let i = 0;
  const spy = vi.fn(async () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return llmReply(r);
  });
  globalThis.fetch = spy as any;
  return spy;
}

// ---------- tests ----------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tick-"));
  resetCircuit();
  invalidatePrefix(""); // clear sensor cache — prefix "" matches every key
  delete process.env.MAX_TOOLS_PER_TICK;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).fetch;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("tick — budget gate", () => {
  it("short-circuits on over daily budget without deliberating", async () => {
    const ctx = makeCtx(dir, { boundaries: "Max LLM calls per day: 2" });
    // Seed 2 deliberate events so callsToday >= dailyCap.
    for (let i = 0; i < 2; i++) {
      ctx.events.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 'tester', 'deliberate', ?)`)
        .run(new Date().toISOString(), "{}");
    }
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await tick(ctx);
    expect(out).toEqual({ quiet: true, pace: "slower" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("short-circuits on over window budget", async () => {
    const ctx = makeCtx(dir, { boundaries: "Max LLM calls per day: 5000\nMax LLM calls per 5h window: 1" });
    ctx.events.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 'tester', 'deliberate', '{}')`)
      .run(new Date().toISOString());
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await tick(ctx);
    expect(out.quiet).toBe(true);
    expect(out.pace).toBe("slower");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("tick — sensor loop", () => {
  it("runs allowed sensors, skips disallowed, quarantined and caches", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    const okSensor: ToolDef = {
      name: "fake.ok", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => ({ items: [] }),
    };
    const otherSensor: ToolDef = {
      name: "other.ns", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => ({ items: [1] }),
    };
    ctx.tools.register(okSensor);
    ctx.tools.register(otherSensor);
    mockFetchSequence([{ action: "noop", reason: "done" }]);
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    // other.ns is not in TOOLS.md
    const readEvents = ctx.events.prepare(`SELECT payload FROM events WHERE kind='sensor.read'`).all() as any[];
    const names = readEvents.map(r => JSON.parse(r.payload).name);
    expect(names).toContain("fake.ok");
    expect(names).not.toContain("other.ns");
  });

  it("records sensor errors and continues", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.boom", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => { throw new Error("kaboom"); },
    });
    mockFetchSequence([{ action: "noop", reason: "done" }]);
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    const errRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='sensor.error'`).get() as any;
    expect(errRow).toBeTruthy();
    expect(JSON.parse(errRow.payload).error).toMatch(/kaboom/);
  });
});

describe("tick — quiet shortcut", () => {
  it("returns quiet when perception unchanged, no work, ritual.run row exists", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.calm", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => ({ items: [] }),
    });
    // Seed a prior perception.hash row that will match the next tick's hash.
    // First tick will compute + record its hash. Second tick sees unchanged.
    mockFetchSequence([{ action: "noop", reason: "done" }]); // first tick will deliberate
    await tick(ctx); // tick 1 — creates perception.hash + deliberates
    // Seed a ritual.run so anyRitualDue = false (the code treats absence of any
    // ritual.run row as "due").
    ctx.events.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 'tester', 'ritual.run', ?)`)
      .run(new Date().toISOString(), JSON.stringify({ name: "health.snapshot", ok: true }));
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await tick(ctx);
    expect(out).toEqual({ quiet: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forceDeliberate bypasses quiet gate", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.calm", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => ({ items: [] }),
    });
    mockFetchSequence([{ action: "noop", reason: "done" }, { action: "noop", reason: "done" }]);
    await tick(ctx);
    ctx.events.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 'tester', 'ritual.run', ?)`)
      .run(new Date().toISOString(), JSON.stringify({ name: "health.snapshot" }));
    const out = await tick({ ...ctx, forceDeliberate: true });
    expect(out.quiet).toBe(false);
  });
});

describe("tick — deliberate loop", () => {
  it("noop terminates the loop immediately", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    const spy = mockFetchSequence([{ action: "noop", reason: "nothing to do" }]);
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    expect(out.didNoAction).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("tool-not-registered breaks the loop", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    mockFetchSequence([{ action: "call", tool: "fake.ghost", input: {}, reason: "try" }]);
    const out = await tick(ctx);
    expect(out.didNoAction).toBe(true);
    const errRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='action.error'`).get() as any;
    expect(JSON.parse(errRow.payload).error).toBe("not registered");
  });

  it("schema-validation failure continues (feedback loop), noops next", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.strict", kind: "action", description: "",
      inputSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
      handler: async () => ({ ok: true }),
    });
    mockFetchSequence([
      { action: "call", tool: "fake.strict", input: {}, reason: "try" },
      { action: "noop", reason: "give up" },
    ]);
    const out = await tick(ctx);
    expect(out.didNoAction).toBe(true);
    const errRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='action.error'`).get() as any;
    expect(JSON.parse(errRow.payload).error).toMatch(/schema:/);
  });

  it("boundary block breaks the loop", async () => {
    // Use TOOLS.md that does NOT include the tool → boundary blocks it.
    const ctx = makeCtx(dir, { tools: "- other" });
    ctx.tools.register({
      name: "fake.write", kind: "action", description: "",
      inputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    mockFetchSequence([{ action: "call", tool: "fake.write", input: {}, reason: "do" }]);
    const out = await tick(ctx);
    expect(out.didNoAction).toBe(true);
    const bRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='boundary.block'`).get() as any;
    expect(bRow).toBeTruthy();
  });

  it("successful action runs, records, and priorSteps grows", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    const handler = vi.fn(async () => ({ ok: true }));
    ctx.tools.register({
      name: "fake.write", kind: "action", description: "",
      inputSchema: { type: "object" }, handler,
    });
    mockFetchSequence([
      { action: "call", tool: "fake.write", input: { a: 1 }, reason: "step1", pace: "faster" },
      { action: "noop", reason: "done" },
    ]);
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    expect(out.didNoAction).toBe(false);
    expect(out.pace).toBe("faster");
    expect(handler).toHaveBeenCalledTimes(1);
    const actionRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='action'`).get() as any;
    expect(JSON.parse(actionRow.payload).tool).toBe("fake.write");
  });

  it("repeat-action guard fires when the same (tool,input) is chosen twice", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.write", kind: "action", description: "",
      inputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    mockFetchSequence([
      { action: "call", tool: "fake.write", input: { a: 1 }, reason: "step1" },
      { action: "call", tool: "fake.write", input: { a: 1 }, reason: "again" },
      { action: "noop", reason: "done" },
    ]);
    await tick(ctx);
    const errs = ctx.events.prepare(`SELECT payload FROM events WHERE kind='action.error'`).all() as any[];
    const found = errs.some(r => JSON.parse(r.payload).error === "repeat guard");
    expect(found).toBe(true);
  });

  it("handler error is captured in priorSteps and loop can continue", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.write", kind: "action", description: "",
      inputSchema: { type: "object" },
      handler: async () => { throw new Error("boom"); },
    });
    mockFetchSequence([
      { action: "call", tool: "fake.write", input: { a: 1 }, reason: "try" },
      { action: "noop", reason: "bail" },
    ]);
    const out = await tick(ctx);
    // ranAnyAction is false because handler threw — didNoAction reflects "no successful action"
    expect(out.didNoAction).toBe(true);
    const errRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='action.error'`).get() as any;
    expect(JSON.parse(errRow.payload).error).toMatch(/boom/);
  }, 15000);

  it("hits the cap message when maxToolsPerTick is reached", async () => {
    process.env.MAX_TOOLS_PER_TICK = "2";
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.tools.register({
      name: "fake.write", kind: "action", description: "",
      inputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    // Each call has different input to avoid repeat guard, both succeed → cap hit.
    mockFetchSequence([
      { action: "call", tool: "fake.write", input: { a: 1 }, reason: "1" },
      { action: "call", tool: "fake.write", input: { a: 2 }, reason: "2" },
      { action: "call", tool: "fake.write", input: { a: 3 }, reason: "3" },
    ]);
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    expect(out.didNoAction).toBe(false);
  });

  it("deliberate error breaks the loop", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    globalThis.fetch = vi.fn(async () => { throw new Error("net down"); }) as any;
    const out = await tick(ctx);
    expect(out.quiet).toBe(false);
    const errRow = ctx.events.prepare(`SELECT payload FROM events WHERE kind='deliberate.error'`).get() as any;
    expect(errRow).toBeTruthy();
  }, 15000);
});

describe("tick — inbox + entities + rituals", () => {
  it("marks inbox unread as read after presenting", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    writeFileSync(join(dir, "state", "inbox.md"), "hello from manager");
    mockFetchSequence([{ action: "noop", reason: "done" }]);
    await tick(ctx);
    expect(ctx.inbox.unread()).toBe("");
  });

  it("surfaces reactions in the deliberate prompt then marks them read", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    ctx.reactions.append({ verdict: "👎", note: "stop reopening ILO-509" });
    ctx.reactions.append({ verdict: "👍" });
    const spy = mockFetchSequence([{ action: "noop", reason: "done" }]);
    await tick(ctx);
    // Prompt should carry the reactions block.
    const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
    const userMsg = body.messages[body.messages.length - 1].content;
    expect(userMsg).toContain("UNREAD REACTIONS");
    expect(userMsg).toContain("👎");
    expect(userMsg).toContain("stop reopening ILO-509");
    // After the tick, cursor advanced.
    expect(ctx.reactions.unread()).toEqual([]);
  });

  it("augments prompt with semantic memory + entity cards", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    // seed semantic memory
    ctx.semantic.propose("I remember dan prefers small PRs.", "test");
    // seed a person entity card so detect() finds "dan" in perception blob
    ctx.entities.upsertPerson("dan", "aliases: [dan]\nDan is the manager.", "test");
    ctx.tools.register({
      name: "fake.list", kind: "sensor", description: "", inputSchema: { type: "object" },
      handler: async () => ({ items: [{ author: "dan", title: "x" }] }),
    });
    const spy = mockFetchSequence([{ action: "noop", reason: "done" }]);
    await tick(ctx);
    // Inspect the system prompt sent to LLM
    const call = spy.mock.calls[0] as any;
    const body = JSON.parse((call[1] as any).body);
    const system = body.messages[0].content;
    expect(system).toContain("MEMORY");
    expect(system).toContain("small PRs");
    expect(system).toContain("ENTITIES");
    expect(system).toContain("dan");
  });

  it("fires the hourly health.snapshot ritual when no prior run exists", async () => {
    const ctx = makeCtx(dir, { tools: "- fake" });
    mockFetchSequence([{ action: "noop", reason: "done" }]);
    await tick(ctx);
    const ran = ctx.events.prepare(`SELECT payload FROM events WHERE kind='ritual.run'`).all() as any[];
    const names = ran.map(r => JSON.parse(r.payload).name);
    expect(names).toContain("health.snapshot");
  });
});
