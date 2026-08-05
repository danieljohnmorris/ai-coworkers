// Memory tools — coworker-invocable actions that query its own past.
// AIC-3: FTS5 search over the event log. Answers "when did I last comment
// on ILO-509?" or "have I already flagged this issue?".
//
// This is an "action" tool by convention because it produces text the model
// consumes; but it is side-effect-free — it never writes and never touches
// external APIs, so it's safe/cheap and doesn't need dry-run gating.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { DatabaseSync } from "node:sqlite";
import { search } from "../runtime/episodic.ts";
import { join } from "node:path";

let db: DatabaseSync | null = null;
function openLazy(ctx: ToolCtx): DatabaseSync {
  if (db) return db;
  // The runtime opens the events db for the current coworker at
  // coworkers/<name>/state/events.db. We reopen it read-only here.
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const path = join(repoRoot, "coworkers", ctx.coworker, "state", "events.db");
  db = new DatabaseSync(path);
  return db;
}

export const memorySearch: ToolDef = {
  name: "memory.search",
  kind: "action",
  description:
    "Search your own past events (comments, actions, deliberations) by keyword. Uses SQLite FTS5. Use it before commenting on a ticket to check whether you already have context, or to recall what you decided about a topic.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "FTS5 query. Bare words are AND'd; quotes for exact phrase; try issue identifiers like ILO-509." },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
    },
  },
  handler: async (input: { query: string; limit?: number }, ctx: ToolCtx) => {
    const results = search(openLazy(ctx), input.query, input.limit ?? 10);
    return { count: results.length, results };
  },
};

// Write to a per-project entity note. Use to build up your own dictionary of
// conventions (labels, priority patterns, reporters) that will auto-load into
// perception on future ticks whenever that project is mentioned. Injection-
// scanned + size-capped by the entity store.
export const memoryNoteProject: ToolDef = {
  name: "memory.note_project",
  kind: "action",
  description:
    "Save or replace a short markdown note about a project. Auto-loaded into perception when the project's key next appears. Use to remember label conventions, priority patterns, or reporter habits per team.",
  inputSchema: {
    type: "object",
    required: ["projectKey", "body"],
    properties: {
      projectKey: { type: "string", description: "e.g. ILO, AIC — the team/project key" },
      body: { type: "string", description: "Concise markdown, ideally <2 KB" },
    },
  },
  handler: async (input: { projectKey: string; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, wouldNote: { project: input.projectKey, chars: input.body.length } };
    // Reuse the entity store keyed to this coworker.
    const { openEntities } = await import("../runtime/entities.ts");
    const { join } = await import("node:path");
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const store = openEntities(join(repoRoot, "coworkers", ctx.coworker, "state", "entities"));
    return store.upsertProject(input.projectKey, input.body, "coworker-note");
  },
};

export const memoryNotePerson: ToolDef = {
  name: "memory.note_person",
  kind: "action",
  description:
    "Save or replace a short markdown note about a person (reporter, teammate). Auto-loaded when their handle next appears.",
  inputSchema: {
    type: "object",
    required: ["handle", "body"],
    properties: {
      handle: { type: "string", description: "handle used in Linear/Slack/etc." },
      body: { type: "string" },
    },
  },
  handler: async (input: { handle: string; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, wouldNote: { person: input.handle, chars: input.body.length } };
    const { openEntities } = await import("../runtime/entities.ts");
    const { join } = await import("node:path");
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const store = openEntities(join(repoRoot, "coworkers", ctx.coworker, "state", "entities"));
    return store.upsertPerson(input.handle, input.body, "coworker-note");
  },
};

// AIC-41 — recall = search + summarise. Coworker asks "have I dealt with
// this before?" and gets a paragraph, not a wall of hits.
export const memoryRecall: ToolDef = {
  name: "memory.recall",
  kind: "action",
  description:
    "Recall what you know about a topic. Searches your event history by keyword, then returns a short paragraph summary. Use for 'have I handled this before?' or 'what did I decide about X?' — cheaper for you to read than raw hits.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      purpose: { type: "string", description: "Optional: what you plan to do with the recall — helps the summariser focus." },
    },
  },
  handler: async (input: { query: string; purpose?: string }, ctx: ToolCtx) => {
    const { openEvents } = await import("../runtime/log.ts");
    const { initEpisodic, search } = await import("../runtime/episodic.ts");
    const { chat } = await import("../runtime/llm.ts");
    const { join } = await import("node:path");
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const dbo = openEvents(join(repoRoot, "coworkers", ctx.coworker, "state", "events.db"));
    initEpisodic(dbo);
    const hits = search(dbo, input.query, 15);
    if (!hits.length) return { summary: "no prior events matched", hitCount: 0 };
    const bullet = hits.map((h) => `- [${h.ts.slice(0, 16)}] ${h.kind}: ${h.snippet}`).join("\n");
    const cfg = {
      baseUrl: ctx.env.OLLAMA_HOST ?? "https://ollama.com",
      apiKey: ctx.env.OLLAMA_API_KEY,
      model: ctx.env.COWORKER_MODEL ?? "gemma4:cloud",
    };
    try {
      const res = await chat(cfg, [
        { role: "system", content: "You summarise a coworker's own past events into one short paragraph. Be terse. No preamble." },
        { role: "user", content:
          `Query: ${input.query}\n` +
          (input.purpose ? `Purpose: ${input.purpose}\n` : "") +
          `\nRecent matching events:\n${bullet}\n\n` +
          `Summarise in 3–5 sentences what you (the coworker) know about this from your own past.`,
        },
      ], { temperature: 0.2, maxTokens: 300 });
      return { summary: res.content.trim(), hitCount: hits.length };
    } catch (err) {
      return {
        summary: `search returned ${hits.length} hits but summariser failed: ${err}. Raw hits: ${bullet}`,
        hitCount: hits.length,
      };
    }
  },
};

export const memoryTools: ToolDef[] = [memorySearch, memoryRecall, memoryNoteProject, memoryNotePerson];
