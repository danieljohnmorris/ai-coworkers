// Coverage for AIC-38 (promotion gate) + AIC-39 (loss guard + version
// snapshot) + AIC-40 (DREAMS.md diary) additions to dreamOnce.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dreamOnce } from "./reflect.ts";
import { openEvents, Log } from "./log.ts";
import { openMemory } from "./memory.ts";
import { openSemantic } from "./semantic.ts";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubLLM } from "../../test/fixtures.ts";

let dir: string; let llm: ReturnType<typeof stubLLM>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ref-g-")); llm = stubLLM(); });
afterEach(() => { llm.reset(); rmSync(dir, { recursive: true, force: true }); });

function seed(name = "t") {
  const rdir = join(dir, name);
  mkdirSync(rdir, { recursive: true });
  return { name: "t", dir: rdir, docs: {} as any, systemPrompt: "you are t", limits: {} as any, cadence: "adaptive" as const };
}

describe("dreamOnce promotion gate (AIC-38)", () => {
  it("rejects a candidate that names nothing in the events window and has no pattern language", async () => {
    const role = seed();
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ tool: "x", input: { issueId: "ILO-42" } }));
    llm.respondWith({ learnings: "generic wisdom about being nice", rollup: "summary" });
    const r = await dreamOnce({ role: role as any, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    expect(r.promoted).toBe(false);
    expect(semantic.read()).toBe(""); // nothing written
  });

  it("accepts a candidate that references a known identifier", async () => {
    const role = seed();
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ input: { issueId: "ILO-42" } }));
    llm.respondWith({ learnings: "- ILO-42 was a parser bug, similar tickets are usually P2", rollup: "week rollup" });
    const r = await dreamOnce({ role: role as any, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    expect(r.promoted).toBe(true);
    expect(semantic.read()).toContain("ILO-42");
  });
});

describe("dreamOnce loss guard (AIC-39)", () => {
  it("blocks promotion if new body would drop >25% of prior char count", async () => {
    const role = seed();
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    const long = "- ILO-42 pattern known\n- ILO-43 also known\n- ILO-44 pattern noticed\n" + "x".repeat(500);
    semantic.propose(long, "seed");
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ input: { issueId: "ILO-42" } }));
    llm.respondWith({ learnings: "- ILO-42 quick note", rollup: "r" });
    const r = await dreamOnce({ role: role as any, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    expect(r.promoted).toBe(false);
    // Prior body untouched
    expect(semantic.read()).toContain("x".repeat(50));
    // Version saved as candidate
    const rows = memory.prepare("SELECT tag FROM memory_versions").all() as any[];
    expect(rows.some((r) => String(r.tag).endsWith("-candidate"))).toBe(true);
  });

  it("saves a 'before' version when promoting", async () => {
    const role = seed();
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    semantic.propose("- prior learning about ILO-42", "seed");
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ input: { issueId: "ILO-42" } }));
    llm.respondWith({ learnings: "- prior learning about ILO-42\n- new learning about ILO-42 patterns", rollup: "r" });
    await dreamOnce({ role: role as any, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    const rows = memory.prepare("SELECT tag FROM memory_versions").all() as any[];
    expect(rows.some((r) => String(r.tag).endsWith("-before"))).toBe(true);
  });
});

describe("dreamOnce Dream Diary (AIC-40)", () => {
  it("appends to DREAMS.md on successful promote", async () => {
    const role = seed();
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ input: { issueId: "ILO-42" } }));
    llm.respondWith({ learnings: "- ILO-42 patterns tend to fit P2", rollup: "r" });
    await dreamOnce({ role: role as any, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    const diary = join(role.dir, "..", "state", "memory", "DREAMS.md");
    expect(existsSync(diary)).toBe(true);
    const text = readFileSync(diary, "utf8");
    expect(text).toContain("dream-");
    expect(text).toContain("promoted");
  });
});
