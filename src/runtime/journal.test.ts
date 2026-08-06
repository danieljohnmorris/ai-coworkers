import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeJournal } from "./journal.ts";
import { openEvents, Log } from "./log.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubLLM } from "../../test/fixtures.ts";

let dir: string;
let llm: ReturnType<typeof stubLLM>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "j-")); llm = stubLLM(); });
afterEach(() => { llm.reset(); rmSync(dir, { recursive: true, force: true }); });

const role: any = { name: "t", dir: "/tmp", docs: {}, systemPrompt: "you are t", limits: {} };

describe("writeJournal", () => {
  it("writes a 'quiet day' entry when no events", async () => {
    const events = openEvents(join(dir, "e.db"));
    const journalDir = join(dir, "journal");
    const log = new Log(events, "t");
    const r = await writeJournal({ role, events, journalDir, llm: llm.llm, log });
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, "utf8")).toMatch(/Quiet day/);
  });

  it("writes a fallback entry when the LLM call errors", async () => {
    const events = openEvents(join(dir, "e.db"));
    const log = new Log(events, "t");
    const yesterday = new Date(Date.now() - 30 * 3600_000).toISOString();
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(yesterday, "t", "action", "{}");
    llm.respondWithError(500, "boom");
    const r = await writeJournal({ role, events, journalDir: join(dir, "j-err"), llm: llm.llm, log });
    expect(readFileSync(r.path, "utf8")).toMatch(/entry generation failed/);
  });

  it("writes an LLM-generated entry when events exist", async () => {
    const events = openEvents(join(dir, "e.db"));
    const log = new Log(events, "t");
    const yesterday = new Date(Date.now() - 30 * 3600_000).toISOString();
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(yesterday, "t", "action", "{}");
    llm.respondWith("triaged some tickets, quiet otherwise.");
    const r = await writeJournal({ role, events, journalDir: join(dir, "j"), llm: llm.llm, log });
    expect(readFileSync(r.path, "utf8")).toContain("triaged");
  });
});
