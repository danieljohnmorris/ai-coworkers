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
