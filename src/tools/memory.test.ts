import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { memorySearch, memoryRecall } from "./memory.ts";
import { openEvents } from "../runtime/log.ts";
import { initEpisodic } from "../runtime/episodic.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";

// The memory.search tool opens events.db from a fixed path relative to the
// module's own URL (repo root / coworkers / <name> / state / events.db).
// So we point it at a real coworker directory under the repo.

const NAME = "__test_memory_search__";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const stateDir = join(REPO_ROOT, "coworkers", NAME, "state");

beforeEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const db = openEvents(join(stateDir, "events.db"));
  initEpisodic(db);
  db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), NAME, "action",
         JSON.stringify({ tool: "linear.comment", input: { issueId: "TEST-1", body: "hello" } }));
});
afterEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
});

describe("memory.search tool", () => {
  it("finds a past event by keyword", async () => {
    const ctx: ToolCtx = { coworker: NAME, dryRun: false, env: {} as NodeJS.ProcessEnv };
    const r = await memorySearch.handler({ query: "TEST-1" }, ctx) as any;
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.results[0].kind).toBe("action");
  });

  it("memory.recall falls back to raw hits when summariser fails", async () => {
    const ctx: ToolCtx = { coworker: NAME, dryRun: false, env: {} as NodeJS.ProcessEnv };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    try {
      const r = await memoryRecall.handler({ query: "TEST-1", purpose: "verify" }, ctx) as any;
      expect(r.hitCount).toBeGreaterThanOrEqual(1);
      expect(r.summary).toMatch(/summariser failed|Raw hits/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("memory.recall returns 'no prior events matched' on empty search", async () => {
    const ctx: ToolCtx = { coworker: NAME, dryRun: false, env: {} as NodeJS.ProcessEnv };
    const r = await memoryRecall.handler({ query: "zzz-nothing-matches" }, ctx) as any;
    expect(r.hitCount).toBe(0);
  });

  it("returns empty on unmatched query", async () => {
    const ctx: ToolCtx = { coworker: NAME, dryRun: false, env: {} as NodeJS.ProcessEnv };
    const r = await memorySearch.handler({ query: "nothing-matches-this" }, ctx) as any;
    expect(r.count).toBe(0);
  });
});
