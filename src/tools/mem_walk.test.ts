// AIC-128 stage 2 — memory.walk tests. The walk function is exercised directly
// against temp events/memory dbs (pure, no coworker layout needed); the tool
// handler is exercised once against a real coworker state dir, mirroring the
// memory.test.ts convention for the lazy-open path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  memWalk, entryScan, memWalkTool,
  CONFIDENCE_THRESHOLD, RAW_EVENT_CAP, PAYLOAD_CAP, CANDIDATES_PER_LEVEL,
  type MemWalkResult,
} from "./mem_walk.ts";
import { openEvents } from "../runtime/log.ts";
import { openMemory } from "../runtime/memory.ts";
import { initEpisodic } from "../runtime/episodic.ts";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";

let dir: string;
let events: DatabaseSync;
let memory: DatabaseSync;

function freshDbs(opts: { fts?: boolean; archive?: boolean } = {}): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  events = openEvents(join(dir, "events.db"));
  if (opts.fts !== false) initEpisodic(events);
  if (opts.archive === false) events.exec("DROP TABLE events_archive");
  memory = openMemory(join(dir, "memory.db"));
}

function hotEvent(kind: string, payload: string): void {
  events
    .prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), "t", kind, payload);
}

function archivedEvent(id: number, payload: string): void {
  events
    .prepare("INSERT INTO events_archive (id, ts, coworker, kind, payload) VALUES (?, ?, ?, ?, ?)")
    .run(id, new Date().toISOString(), "t", "action", payload);
}

function rollup(args: {
  period: string; level: number; body: string;
  parentId?: number | null; sourceRange?: string | null;
}): number {
  const info = memory
    .prepare(
      `INSERT INTO rollups (period, period_start, period_end, body, level, parent_id, source_range)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(args.period, "2026-08-01", "2026-08-27", args.body, args.level,
         args.parentId ?? null, args.sourceRange ?? null);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-walk-"));
  freshDbs();
});
afterEach(() => {
  events.close();
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

// A three-rung ladder over archive-only raw events: the bottom rung lives
// entirely in events_archive (AIC-127 retention moved it out of the hot
// table), which is exactly what memory.walk must still reach.
function seedLadder(): { month: number; week: number; day: number } {
  archivedEvent(10, JSON.stringify({ tool: "linear.comment", input: { issueId: "ILO-509", body: "parser bug reproduced" } }));
  archivedEvent(11, JSON.stringify({ tool: "github.comment", input: { body: "parser fix posted for ILO-509" } }));
  archivedEvent(12, JSON.stringify({ note: "ilo-509 parser regression suite added" }));
  const month = rollup({
    period: "month", level: 3, body: "August: the ilo-509 parser incident and onboarding docs",
    sourceRange: JSON.stringify([10, 12]),
  });
  const week = rollup({
    period: "week", level: 2, parentId: month, body: "parser fixes for ilo-509 landed",
    sourceRange: JSON.stringify([10, 11]),
  });
  const day = rollup({
    period: "day", level: 1, parentId: week, body: "ilo-509 parser bug triaged",
    sourceRange: JSON.stringify([10, 12]),
  });
  return { month, week, day };
}

describe("memory.walk (AIC-128 stage 2)", () => {
  it("walks month → week → day → raw, resolving old ids through events_archive", () => {
    const { month, week, day } = seedLadder();
    const r = memWalk(events, memory, "ilo-509 parser");

    expect(r.refused).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(r.trace[0]).toMatchObject({ level: 3, id: month });
    expect(r.trace[1]).toMatchObject({ level: 2, id: week });
    expect(r.trace[2]).toMatchObject({ level: 1, id: day });
    // The trace ends in raw events; ids 10–12 resolved from the archive.
    const rawIds = r.trace.filter((t) => t.level === 0).map((t) => t.id);
    expect(rawIds).toEqual(expect.arrayContaining([10, 11, 12]));
    expect(r.events.map((e) => e.id).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(r.events.every((e) => e.source === "events_archive")).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("refuses below the confidence threshold and issues no queries beyond the entry scan", () => {
    // Nothing in the ladder or the hot table relates to the query.
    rollup({ period: "week", level: 2, body: "gardening notes and tomato harvest", sourceRange: JSON.stringify([1, 1]) });
    hotEvent("action", JSON.stringify({ note: "planted tomatoes" }));

    // Statement-counting proxies: memWalk may only touch the db via
    // .prepare, so counting prepares counts queries.
    const counted = (db: DatabaseSync): { db: DatabaseSync; count: () => number } => {
      let n = 0;
      const proxy = new Proxy(db, {
        get(target, prop) {
          if (prop === "prepare") {
            return (...args: [string]) => { n++; return target.prepare(...args); };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { db: proxy as DatabaseSync, count: () => n };
    };
    const ev = counted(events);
    const mem = counted(memory);

    const r = memWalk(ev.db, mem.db, "kubernetes rollout");
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/no confident entry point/);
    expect(r.reason).toContain(String(CONFIDENCE_THRESHOLD));
    expect(r.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(r.trace).toEqual([]);
    expect(r.events).toEqual([]);

    // A second, scan-only pass on fresh counters must prepare exactly as
    // many statements as the refused walk did — proof the refusal path does
    // no navigation queries after the entry scan (ADR-0008 acceptance).
    const ev2 = counted(events);
    const mem2 = counted(memory);
    entryScan(ev2.db, mem2.db, "kubernetes rollout");
    expect(mem.count()).toBe(mem2.count());
    expect(ev.count()).toBe(ev2.count());
  });

  it("refuses an untokenizable query", () => {
    const r = memWalk(events, memory, "!!! ???");
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/no searchable tokens/);
  });

  it("caps raw events at the documented limit, ranked by token overlap, and truncates payloads to ~2 KB", () => {
    // 60 archived events inside one day span: the first 20 match both query
    // tokens, the rest only one — the cap must keep the best-ranked 40.
    for (let i = 1; i <= 60; i++) {
      const body = i <= 20
        ? `overflow retry incident number ${i} ${"x".repeat(i === 5 ? 5000 : 10)}`
        : `overflow noise ${i}`;
      archivedEvent(i, JSON.stringify({ note: body }));
    }
    rollup({
      period: "day", level: 1, body: "overflow incident postmortem",
      sourceRange: JSON.stringify([1, 60]),
    });

    const r = memWalk(events, memory, "overflow incident");
    expect(r.refused).toBe(false);
    expect(r.events).toHaveLength(RAW_EVENT_CAP);
    expect(r.truncated).toBe(true);
    // Best first: the 2-token events (ids 1–20) outrank the 1-token ones,
    // ties broken by id ascending.
    expect(r.events.slice(0, 20).map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Payload truncation: event 5 was seeded with a 5 KB body.
    const ev5 = r.events.find((e) => e.id === 5)!;
    expect(ev5.payload.length).toBe(PAYLOAD_CAP + "…[truncated]".length);
    expect(ev5.payload.endsWith("…[truncated]")).toBe(true);
    expect(r.events.every((e) => e.payload.length <= PAYLOAD_CAP + "…[truncated]".length)).toBe(true);
    // The trace's raw rows mirror the capped set exactly.
    expect(r.trace.filter((t) => t.level === 0).map((t) => t.id)).toEqual(r.events.map((e) => e.id));
  });

  it("keeps at most three candidates per ladder level", () => {
    // One week rung with five lexically-tied day children: only the best
    // three may be walked and traced.
    const week = rollup({
      period: "week", level: 2, body: "parser war week", sourceRange: JSON.stringify([1, 1]),
    });
    for (let i = 1; i <= 5; i++) {
      rollup({
        period: "day", level: 1, parentId: week, body: `parser day ${i}`,
        sourceRange: JSON.stringify([i, i]),
      });
      archivedEvent(i, `parser event ${i}`);
    }
    const r = memWalk(events, memory, "parser");
    const dayRows = r.trace.filter((t) => t.level === 1);
    expect(dayRows.length).toBeLessThanOrEqual(CANDIDATES_PER_LEVEL);
    const uniqueIds = new Set(dayRows.map((t) => t.id));
    expect(uniqueIds.size).toBe(dayRows.length);
  });

  it("is a pure tool: no LLM/network calls, and the walk takes no llm config", () => {
    seedLadder();
    const calls: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); throw new Error("network disabled"); }) as typeof fetch;
    try {
      const r = memWalk(events, memory, "ilo-509 parser");
      expect(r.refused).toBe(false);
      expect(r.events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(0);
    // The walk signature is (events, memory, query) — no llm/config slot
    // exists to abuse, and the ToolDef declares no credentials.
    expect(memWalk.length).toBe(3);
    expect(memWalkTool.name).toBe("memory.walk");
    expect(memWalkTool.requiresCreds).toBeUndefined();
    expect(memWalkTool.inputSchema).toMatchObject({
      type: "object", required: ["query"],
      properties: { query: { type: "string" } },
    });
  });

  it("returns a stable trace shape: {level,id,why} rows, coarse → fine, raw last, mirroring events", () => {
    seedLadder();
    const r = memWalk(events, memory, "ilo-509 parser");

    for (const step of r.trace) {
      expect(Object.keys(step).sort()).toEqual(["id", "level", "why"]);
      expect(typeof step.level).toBe("number");
      expect(typeof step.id).toBe("number");
      expect(step.why.length).toBeGreaterThan(0);
    }
    // Levels are non-increasing: rungs coarse → fine, then the raw block.
    const levels = r.trace.map((t) => t.level);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
    }
    // Rollup rungs are never revisited; raw rows mirror the events array.
    const rungIds = r.trace.filter((t) => t.level > 0).map((t) => t.id);
    expect(new Set(rungIds).size).toBe(rungIds.length);
    const rawRows = r.trace.filter((t) => t.level === 0);
    expect(rawRows.map((t) => t.id)).toEqual(r.events.map((e) => e.id));
    // Result envelope keys are part of the stable contract.
    expect(Object.keys(r).sort()).toEqual(
      ["confidence", "events", "matchedTokens", "queryTokens", "refused", "trace", "truncated"]
    );
  });

  it("walks the ladder when events_fts is absent (pre-episodic events db)", () => {
    freshDbs({ fts: false });
    const { month } = seedLadder();
    const r = memWalk(events, memory, "ilo-509 parser");
    expect(r.refused).toBe(false);
    expect(r.trace[0]).toMatchObject({ level: 3, id: month });
    expect(r.events.length).toBe(3);
  });

  it("resolves hot-only spans when events_archive is absent (pre-AIC-127 events db)", () => {
    freshDbs({ archive: false });
    hotEvent("action", JSON.stringify({ input: { issueId: "ILO-509", body: "parser bug" } }));
    rollup({
      period: "day", level: 1, body: "ilo-509 parser day",
      sourceRange: JSON.stringify([1, 1]),
    });
    const r = memWalk(events, memory, "ilo-509 parser");
    expect(r.refused).toBe(false);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].source).toBe("events");
  });

  it("annotates a legacy NULL source_range rung instead of drilling through it", () => {
    // A day rung with no span is a dead end: reported honestly, never
    // resolved by guessing (ADR-0008). It is the coarsest level present,
    // so the walk enters it directly.
    const dayNull = rollup({ period: "day", level: 1, body: "ilo-509 parser legacy day" });
    const r = memWalk(events, memory, "ilo-509 parser");
    expect(r.refused).toBe(false);
    expect(r.trace.find((t) => t.id === dayNull)?.why).toMatch(/unlinked/);
    expect(r.events).toEqual([]);
  });

  it("treats a malformed source_range as unlinked (read-side link-rot defense)", () => {
    const weekBad = rollup({
      period: "week", level: 2, body: "ilo-509 parser week", sourceRange: "not-json",
    });
    const r = memWalk(events, memory, "ilo-509 parser");
    expect(r.refused).toBe(false);
    // Childless mid-level rung: terminal, annotated, never drilled.
    expect(r.trace.find((t) => t.id === weekBad)?.why).toMatch(/unlinked/);
    expect(r.events).toEqual([]);
  });
});

describe("mem.walk tool handler", () => {
  const NAME = "__test_mem_walk__";
  const REPO_ROOT = new URL("../..", import.meta.url).pathname;
  const stateDir = join(REPO_ROOT, "coworkers", NAME, "state");

  beforeEach(() => {
    rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const db = openEvents(join(stateDir, "events.db"));
    initEpisodic(db);
    db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), NAME, "action",
           JSON.stringify({ tool: "linear.comment", input: { issueId: "AIC-1", body: "deploy was flaky" } }));
    db.close();
    const mem = openMemory(join(stateDir, "memory.db"));
    mem.prepare(
      `INSERT INTO rollups (period, period_start, period_end, body, level, parent_id, source_range)
       VALUES ('day', '2026-08-27', '2026-08-27', 'deploy flaky alert investigated', 1, NULL, ?)`
    ).run(JSON.stringify([1, 1]));
    mem.close();
  });
  afterEach(() => {
    rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  });

  it("lazy-opens the coworker dbs and walks end-to-end, deduping span vs FTS hits", async () => {
    const ctx: ToolCtx = { coworker: NAME, dryRun: false, env: {} as NodeJS.ProcessEnv };
    const r = await memWalkTool.handler({ query: "deploy flaky" }, ctx) as MemWalkResult;
    expect(r.refused).toBe(false);
    // Event 1 is both a hot FTS hit and inside the day span — one row, not two.
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ id: 1, source: "events" });
    expect(r.trace.filter((t) => t.level === 0)).toHaveLength(1);
  });
});
