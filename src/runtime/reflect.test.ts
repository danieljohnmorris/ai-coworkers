import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dreamOnce } from "./reflect.ts";
import { initEpisodic } from "./episodic.ts";
import type { DatabaseSync } from "node:sqlite";
import type { SemanticMemory } from "./semantic.ts";
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

describe("dreamOnce prune archival (AIC-127)", () => {
  const oldTs = new Date(Date.now() - 60 * 86400_000).toISOString();

  interface PruneCtx {
    events: DatabaseSync;
    memory: DatabaseSync;
    semantic: SemanticMemory;
  }

  function setup(): PruneCtx {
    const events = openEvents(join(dir, "e.db"));
    initEpisodic(events);
    return {
      events,
      memory: openMemory(join(dir, "m.db")),
      semantic: openSemantic(join(dir, "MEMORY.md")),
    };
  }

  function insert(events: DatabaseSync, ts: string, kind: string, payload = "{}") {
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 't', ?, ?)")
      .run(ts, kind, payload);
  }

  async function dream(ctx: PruneCtx) {
    llm.respondWith({ learnings: "- I noticed a pattern in old tickets", rollup: "week rollup" });
    return dreamOnce({ role, ...ctx, llm: llm.llm, log: new Log(ctx.events, "t") });
  }

  it("archives rows older than the cutoff instead of deleting them", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "action", JSON.stringify({ stale: true }));
    insert(ctx.events, new Date().toISOString(), "action", JSON.stringify({ fresh: true }));
    const r = await dream(ctx);
    expect(typeof r.prunedRows).toBe("number");
    expect(r.prunedRows).toBe(1);
    expect(r.archivedRows).toBe(1);
    const archived = ctx.events.prepare("SELECT ts, kind, payload FROM events_archive").all() as { payload: string }[];
    expect(archived).toHaveLength(1);
    expect(archived[0].payload).toContain("stale");
    // The stale row is gone from the hot table; the fresh one survives.
    const hot = ctx.events.prepare("SELECT payload FROM events WHERE kind = 'action'").all() as { payload: string }[];
    expect(hot.some((h) => h.payload.includes("stale"))).toBe(false);
    expect(hot.some((h) => h.payload.includes("fresh"))).toBe(true);
  });

  it("never prunes or archives ritual.run and note events", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "ritual.run", JSON.stringify({ name: "reflect.weekly" }));
    insert(ctx.events, oldTs, "note", JSON.stringify({ body: "keep me" }));
    insert(ctx.events, new Date().toISOString(), "action", "{}");
    const r = await dream(ctx);
    expect(r.prunedRows).toBe(0);
    expect(r.archivedRows).toBe(0);
    expect(ctx.events.prepare("SELECT COUNT(*) AS n FROM events_archive").get()).toMatchObject({ n: 0 });
    const kinds = (ctx.events.prepare("SELECT kind FROM events").all() as { kind: string }[]).map((k) => k.kind);
    expect(kinds).toContain("ritual.run");
    expect(kinds).toContain("note");
  });

  it("is idempotent — a row already archived by a crashed prune is not duplicated", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "action", JSON.stringify({ stale: true }));
    // Simulate a crash between archive-insert and hot-delete: the row already
    // sits in the archive but still exists in the hot table.
    ctx.events.exec(`INSERT INTO events_archive (id, ts, coworker, kind, payload)
                     SELECT id, ts, coworker, kind, payload FROM events WHERE kind = 'action'`);
    insert(ctx.events, new Date().toISOString(), "action", "{}");
    const r = await dream(ctx);
    expect(r.prunedRows).toBe(1);
    expect(r.archivedRows).toBe(0); // INSERT OR IGNORE skipped the duplicate
    const archived = ctx.events.prepare("SELECT id FROM events_archive").all() as { id: number }[];
    expect(archived).toHaveLength(1);
  });

  it("keeps FTS consistent: archived ids leave events_fts, hot ids remain", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "action", JSON.stringify({ ticket: "ILO-777" }));
    insert(ctx.events, new Date().toISOString(), "action", JSON.stringify({ ticket: "ILO-888" }));
    await dream(ctx);
    // node:sqlite rows are untyped Records; the SELECT fixes the shape.
    const archivedRow = ctx.events.prepare("SELECT id FROM events_archive").get() as { id: number };
    const archivedId = archivedRow.id;
    const ftsIds = (ctx.events.prepare("SELECT event_id FROM events_fts").all() as { event_id: number | string }[])
      .map((r) => Number(r.event_id));
    expect(ftsIds).not.toContain(Number(archivedId));
    const hotRow = ctx.events.prepare("SELECT id FROM events WHERE payload LIKE '%ILO-888%'").get() as { id: number };
    const hotId = hotRow.id;
    expect(ftsIds).toContain(Number(hotId));
  });

  it("rolls back and keeps hot rows when the archive insert fails", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "action", JSON.stringify({ stale: true }));
    insert(ctx.events, new Date().toISOString(), "action", "{}");
    ctx.events.exec("DROP TABLE events_archive");
    const r = await dream(ctx);
    // Prune failed but the dream itself still completes; nothing was lost.
    expect(r.prunedRows).toBe(0);
    expect(r.archivedRows).toBe(0);
    const stale = ctx.events.prepare("SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%stale%'").get() as { n: number };
    expect(stale.n).toBe(1);
  });

  it("records but does not throw when the WAL checkpoint fails", async () => {
    const ctx = setup();
    insert(ctx.events, oldTs, "action", JSON.stringify({ stale: true }));
    insert(ctx.events, new Date().toISOString(), "action", "{}");
    // Wrap the real db so only the checkpoint PRAGMA blows up; native methods
    // must stay bound to the real DatabaseSync instance.
    const proxied = new Proxy(ctx.events, {
      get(target, prop) {
        if (prop === "exec") {
          return (sql: string) => {
            if (sql.includes("wal_checkpoint")) throw new Error("checkpoint boom");
            return target.exec(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    // Structurally identical wrapper around a real DatabaseSync — cast is safe.
    const poisoned = proxied as unknown as DatabaseSync;
    llm.respondWith({ learnings: "- I noticed a pattern in old tickets", rollup: "week rollup" });
    const r = await dreamOnce({
      role, events: poisoned, memory: ctx.memory, semantic: ctx.semantic,
      llm: llm.llm, log: new Log(ctx.events, "t"),
    });
    // Archive + delete already committed before the checkpoint failed.
    expect(r.prunedRows).toBe(1);
    expect(r.archivedRows).toBe(1);
  });
});

describe("dreamOnce ladder provenance (AIC-128)", () => {
  function setup() {
    const events = openEvents(join(dir, "e.db"));
    return {
      events,
      memory: openMemory(join(dir, "m.db")),
      semantic: openSemantic(join(dir, "MEMORY.md")),
      log: new Log(events, "t"),
    };
  }

  function insertAction(events: DatabaseSync, ts: string): number {
    const info = events
      .prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 't', 'action', '{}')")
      .run(ts);
    return Number(info.lastInsertRowid);
  }

  it("writes the weekly rollup with level 2 and the distilled event id span", async () => {
    const ctx = setup();
    const now = new Date().toISOString();
    const first = insertAction(ctx.events, now);
    insertAction(ctx.events, now);
    const last = insertAction(ctx.events, now);
    llm.respondWith({ learnings: "- I noticed a pattern", rollup: "week rollup" });
    await dreamOnce({ role, ...ctx, llm: llm.llm });
    const r = ctx.memory
      .prepare("SELECT level, parent_id, source_range FROM rollups WHERE period = 'week'")
      .get() as Record<string, unknown>;
    expect(r.level).toBe(2);
    expect(r.parent_id).toBeNull();
    expect(r.source_range).toBe(JSON.stringify([first, last]));
  });

  it("adopts day rollups inside the week and leaves outside/legacy rows unlinked", async () => {
    const ctx = setup();
    insertAction(ctx.events, new Date().toISOString());
    const day = (startOffsetDays: number) => {
      const start = new Date(Date.now() - startOffsetDays * 86400_000).toISOString();
      const end = new Date(Date.now() - (startOffsetDays - 1) * 86400_000).toISOString();
      const info = ctx.memory
        .prepare(`INSERT INTO rollups (period, period_start, period_end, body, level, source_range)
                  VALUES ('day', ?, ?, 'd', 1, NULL)`)
        .run(start, end);
      return Number(info.lastInsertRowid);
    };
    const inside = day(3);            // falls inside the 7-day dream window
    const outside = day(20);          // older than the window — stays orphan
    // Legacy day rollup with NULL level — must never be adopted.
    const legacyInfo = ctx.memory
      .prepare(`INSERT INTO rollups (period, period_start, period_end, body)
                VALUES ('day', ?, ?, 'legacy')`)
      .run(new Date(Date.now() - 2 * 86400_000).toISOString(), new Date().toISOString());
    const legacy = Number(legacyInfo.lastInsertRowid);

    llm.respondWith({ learnings: "- I noticed a pattern", rollup: "week rollup" });
    await dreamOnce({ role, ...ctx, llm: llm.llm });

    const week = ctx.memory
      .prepare("SELECT id FROM rollups WHERE period = 'week'")
      .get() as Record<string, unknown>;
    const parentOf = (id: number) => {
      const row = ctx.memory
        .prepare("SELECT parent_id FROM rollups WHERE id = ?")
        .get(id) as Record<string, unknown>;
      return row.parent_id;
    };
    expect(parentOf(inside)).toBe(week.id);
    expect(parentOf(outside)).toBeNull();
    expect(parentOf(legacy)).toBeNull();
  });
});
