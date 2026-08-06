import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dreamOnce } from "./reflect.ts";
import { openEvents, Log } from "./log.ts";
import { openMemory } from "./memory.ts";
import { openSemantic } from "./semantic.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubLLM } from "../../test/fixtures.ts";

let dir: string;
let llm: ReturnType<typeof stubLLM>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ref-")); llm = stubLLM(); });
afterEach(() => { llm.reset(); rmSync(dir, { recursive: true, force: true }); });

const role: any = { name: "t", dir: "/tmp", docs: {}, systemPrompt: "you are t", limits: {} };

describe("dreamOnce", () => {
  it("no-ops when no events in window", async () => {
    const events = openEvents(join(dir, "e.db"));
    const r = await dreamOnce({
      role, events,
      memory: openMemory(join(dir, "m.db")),
      semantic: openSemantic(join(dir, "MEMORY.md")),
      llm: llm.llm, log: new Log(events, "t"),
    });
    expect(r.promoted).toBe(false);
    expect(r.reason).toMatch(/no events/);
  });

  it("promotes learnings and writes a rollup", async () => {
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ tool: "x", input: {} }));
    llm.respondWith({ learnings: "- dogfood tickets tend to be P2", rollup: "long weekly summary" });
    const r = await dreamOnce({
      role, events, memory, semantic,
      llm: llm.llm, log: new Log(events, "t"),
    });
    expect(r.promoted).toBe(true);
    expect(semantic.read()).toContain("dogfood");
    const rollups = memory.prepare("SELECT body FROM rollups").all() as any[];
    expect(rollups[0].body).toBe("long weekly summary");
  });

  it("appends a dreams-diary entry with dropped bullets when memory shrinks (but stays under loss guard)", async () => {
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"), 4096);
    // Seed prior memory with several bullets — enough that dropping some stays under the 25% loss guard.
    const prior = "- keep 1\n- keep 2\n- keep 3\n- keep 4\n- keep 5\n- keep 6\n- drop me\n- drop me too";
    semantic.propose(prior, "seed");
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ pattern: "noticed" }));
    // New learnings: keep most, drop the two "drop" lines.
    const newLearnings = "- keep 1\n- keep 2\n- keep 3\n- keep 4\n- keep 5\n- keep 6\n- I noticed a new observation";
    llm.respondWith({ learnings: newLearnings, rollup: "week rollup" });
    const roleWithDir = { ...role, dir: dir + "/role" };
    const r = await dreamOnce({ role: roleWithDir, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    expect(r.promoted).toBe(true);
  });

  it("rolls back promotion when semantic.propose rejects (over cap)", async () => {
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    // Cap of 20 chars — the "learnings" below will exceed it and propose() will reject.
    const semantic = openSemantic(join(dir, "MEMORY.md"), 20);
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", JSON.stringify({ issueId: "ILO-99" }));
    llm.respondWith({ learnings: "- I noticed a lengthy observation that exceeds the tiny twenty character cap", rollup: "r" });
    const r = await dreamOnce({
      role: { ...role, dir: dir + "/role" }, events, memory, semantic,
      llm: llm.llm, log: new Log(events, "t"),
    });
    expect(r.promoted).toBe(false);
    expect(semantic.read()).toBe("");
  });

  it("records but does not throw on LLM error", async () => {
    const events = openEvents(join(dir, "e.db"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "t", "action", "{}");
    llm.respondWithError(500, "boom");
    const r = await dreamOnce({
      role, events,
      memory: openMemory(join(dir, "m.db")),
      semantic: openSemantic(join(dir, "MEMORY.md")),
      llm: llm.llm, log: new Log(events, "t"),
    });
    expect(r.promoted).toBe(false);
    expect(r.reason).toMatch(/llm error/);
  });
});
