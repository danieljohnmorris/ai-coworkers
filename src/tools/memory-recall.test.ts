import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { memoryRecall } from "./memory.ts";
import { openEvents } from "../runtime/log.ts";
import { initEpisodic } from "../runtime/episodic.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";
import { stubLLM } from "../../test/fixtures.ts";

const NAME = "__test_memory_recall__";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
let llm: ReturnType<typeof stubLLM>;

beforeEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  mkdirSync(join(REPO_ROOT, "coworkers", NAME, "state"), { recursive: true });
  const db = openEvents(join(REPO_ROOT, "coworkers", NAME, "state", "events.db"));
  initEpisodic(db);
  db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), NAME, "action",
         JSON.stringify({ tool: "linear.set_labels", input: { issueId: "ILO-42" } }));
  llm = stubLLM();
});
afterEach(() => {
  llm.reset();
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
});

describe("memory.recall (AIC-41)", () => {
  it("returns 'no prior events matched' with hitCount 0 when nothing found", async () => {
    const ctx: ToolCtx = {
      coworker: NAME, dryRun: false,
      env: { OLLAMA_HOST: "http://fake-llm", OLLAMA_API_KEY: "k", COWORKER_MODEL: "fake" } as any,
    };
    const r = await memoryRecall.handler({ query: "unrelated-topic-xyz" }, ctx) as any;
    expect(r.hitCount).toBe(0);
    expect(r.summary).toMatch(/no prior/);
  });

  it("returns an LLM-summarised paragraph when hits are found", async () => {
    const ctx: ToolCtx = {
      coworker: NAME, dryRun: false,
      env: { OLLAMA_HOST: "http://fake-llm", OLLAMA_API_KEY: "k", COWORKER_MODEL: "fake" } as any,
    };
    llm.respondWith("Previously labelled ILO-42 as Feature during backlog catch-up.");
    const r = await memoryRecall.handler({ query: "ILO-42", purpose: "avoid double-labelling" }, ctx) as any;
    expect(r.hitCount).toBeGreaterThan(0);
    expect(r.summary).toContain("ILO-42");
  });

  it("falls back to raw hits when the summariser fails", async () => {
    const ctx: ToolCtx = {
      coworker: NAME, dryRun: false,
      env: { OLLAMA_HOST: "http://fake-llm", OLLAMA_API_KEY: "k", COWORKER_MODEL: "fake" } as any,
    };
    llm.respondWithError(500, "boom");
    const r = await memoryRecall.handler({ query: "ILO-42" }, ctx) as any;
    expect(r.hitCount).toBeGreaterThan(0);
    expect(r.summary).toMatch(/summariser failed/);
  });
});
