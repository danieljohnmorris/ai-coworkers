// Extra integration coverage for tick.ts uncovered branches: sensor error,
// entity injection into system prompt, unknown-tool selection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tick } from "../src/runtime/tick.ts";
import { openEvents, Log } from "../src/runtime/log.ts";
import { openMemory } from "../src/runtime/memory.ts";
import { openHygiene } from "../src/runtime/hygiene.ts";
import { openSemantic } from "../src/runtime/semantic.ts";
import { openEntities } from "../src/runtime/entities.ts";
import { initEpisodic } from "../src/runtime/episodic.ts";
import { ToolRegistry, type ToolDef } from "../src/runtime/tools.ts";
import { loadRole } from "../src/runtime/role.ts";
import { _resetForTests as resetCircuit } from "../src/runtime/circuit.ts";
import { stubLLM } from "./fixtures.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string; let llm: ReturnType<typeof stubLLM>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tickx-")); resetCircuit(); llm = stubLLM(); });
afterEach(() => { llm.reset(); rmSync(dir, { recursive: true, force: true }); });

function seed(name: string, tools_md = "- fake") {
  const rd = join(dir, name, "role");
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, "ROLE.md"), "you are t");
  writeFileSync(join(rd, "RESPONSIBILITIES.md"), "-");
  writeFileSync(join(rd, "AUTHORITY.md"), "-");
  writeFileSync(join(rd, "BOUNDARIES.md"), "## Must not touch\n- nothing");
  writeFileSync(join(rd, "RITUALS.md"), "-");
  writeFileSync(join(rd, "RELATIONSHIPS.md"), "-");
  writeFileSync(join(rd, "TOOLS.md"), tools_md);
  writeFileSync(join(rd, "WORKSPACE.md"), "-");
  return loadRole(dir, name);
}

function ctxOf(role: any, tools: ToolRegistry) {
  const sd = join(dir, role.name, "state");
  mkdirSync(sd, { recursive: true });
  const events = openEvents(join(sd, "events.db"));
  initEpisodic(events);
  return {
    role, events,
    memory: openMemory(join(sd, "memory.db")),
    hygiene: openHygiene(join(sd, "hygiene.db")),
    semantic: openSemantic(join(sd, "memory", "MEMORY.md")),
    entities: openEntities(join(sd, "entities")),
    tools, llm: llm.llm, dryRun: true,
    log: new Log(events, role.name),
  };
}

describe("tick extra paths", () => {
  it("records sensor.error and continues", async () => {
    const role = seed("t");
    const tools = new ToolRegistry();
    const bad: ToolDef = {
      name: "fake.broken", kind: "sensor",
      description: "", inputSchema: { type: "object" },
      handler: async () => { throw new Error("sensor blew up"); },
    };
    tools.register(bad);
    llm.respondWith({ action: "noop", reason: "ok" });
    const c = ctxOf(role, tools);
    await tick(c);
    const err = c.events.prepare("SELECT payload FROM events WHERE kind = 'sensor.error'").get() as any;
    expect(err.payload).toContain("sensor blew up");
  });

  it("logs boundary block when action targets an unknown tool", async () => {
    const role = seed("t");
    const tools = new ToolRegistry();
    llm.respondWith({ action: "call", tool: "no.such.tool", input: {}, reason: "r" });
    const c = ctxOf(role, tools);
    await tick(c);
    const b = c.events.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('boundary.block','action.error')").get() as any;
    expect(b.n).toBeGreaterThan(0);
  });

  it("injects entity cards into the system prompt when perception mentions them", async () => {
    const role = seed("t", "- fake");
    const tools = new ToolRegistry();
    const sensor: ToolDef = {
      name: "fake.mention", kind: "sensor",
      description: "", inputSchema: { type: "object" },
      handler: async () => ({ text: "dan asked about this" }),
    };
    tools.register(sensor);
    const c = ctxOf(role, tools);
    c.entities.upsertPerson("dan", "Prefers small PRs.", "test");
    let seenPrompt = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenPrompt = body.messages?.[0]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"noop","reason":"ok"}' } }] }));
    }) as typeof fetch;
    try {
      await tick(c);
      expect(seenPrompt).toContain("ENTITIES");
      expect(seenPrompt).toContain("dan");
    } finally { globalThis.fetch = origFetch; }
  });
});
