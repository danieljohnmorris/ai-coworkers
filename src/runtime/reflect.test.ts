import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  dreamOnce,
  writeMemoryMap,
  rollupInputRows,
  isRetrievalOutputEvent,
  RETRIEVAL_TOOLS,
} from "./reflect.ts";
import { initEpisodic } from "./episodic.ts";
import type { DatabaseSync } from "node:sqlite";
import type { SemanticMemory } from "./semantic.ts";
import { openEvents, Log } from "./log.ts";
import { openMemory } from "./memory.ts";
import { openSemantic } from "./semantic.ts";
import { readFileSync, existsSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubLLM } from "../../test/fixtures.ts";
import { memoryTools } from "../tools/memory.ts";
import { memWalkTools } from "../tools/mem_walk.ts";

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

describe("memory-map projection (AIC-131)", () => {
  function seedLadder(memory: DatabaseSync) {
    const ins = memory.prepare(
      `INSERT INTO rollups (period, period_start, period_end, body, level, parent_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    // Legacy pre-AIC-128 weekly rollup — NULL level must land on the week rung.
    const legacy = Number(ins.run("week", "2026-07-01", "2026-07-08", "Legacy week before the ladder existed.", null, null).lastInsertRowid);
    const weekA = Number(ins.run("week", "2026-08-10", "2026-08-17", "Older week. Deploy cadence settled.", 2, null).lastInsertRowid);
    const weekB = Number(ins.run("week", "2026-08-17", "2026-08-24", "Newer week. Handled the flaky alert.", 2, null).lastInsertRowid);
    const month = Number(ins.run("month", "2026-08-01", "2026-08-31", "August consolidated the ladder work.", 3, null).lastInsertRowid);
    const day = Number(ins.run("day", "2026-08-18", "2026-08-19", "Day the alert fired. Investigated and silenced.", 1, weekB).lastInsertRowid);
    const orphan = Number(ins.run("day", "2026-08-20", "2026-08-21", "Orphan day with no parent link.", 1, null).lastInsertRowid);
    return { legacy, weekA, weekB, month, day, orphan };
  }

  function queueCandidate(memory: DatabaseSync, tag: string, body: string) {
    memory.exec(`
      CREATE TABLE IF NOT EXISTS memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, tag TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
    memory.prepare(`INSERT INTO memory_versions (ts, tag, body) VALUES (?, ?, ?)`)
      .run("2026-08-27T03:00:00.000Z", tag, body);
  }

  it("renders the ladder level-ordered, newest-first, with the queue on top", () => {
    const memory = openMemory(join(dir, "m.db"));
    const ids = seedLadder(memory);
    queueCandidate(memory, "dream-2026-08-24-candidate", "- ILO-42 was a parser bug. Similar tickets are usually P2.");
    const text = writeMemoryMap(memory, { role: { dir: join(dir, "role"), name: "t" } });

    expect(text.startsWith("# Memory map — t\n")).toBe(true);
    expect(text).toContain("Generated by the reflect ritual — read-only projection of memory.db; edit nothing here.");
    // Section order: header < queued < months < weeks < footer.
    const at = (s: string) => text.indexOf(s);
    expect(at("## Queued promotions")).toBeGreaterThan(-1);
    expect(at("## Queued promotions")).toBeLessThan(at("## Months"));
    expect(at("## Months")).toBeLessThan(at("## Weeks"));
    expect(at("## Weeks")).toBeLessThan(at("Rungs below this line are raw events — ask the coworker to run memory.walk to descend."));
    // Queue entry: tag + excerpt (first sentence only).
    expect(text).toContain("`dream-2026-08-24-candidate`");
    expect(text).toContain("ILO-42 was a parser bug.");
    expect(text).not.toContain("Similar tickets"); // excerpt is one sentence
    // Month section with its own id; week children not linked here.
    expect(text).toContain(`### month · 2026-08-01 → 2026-08-31 · id ${ids.month}`);
    // Weeks newest-first; the day child renders beneath its linked week.
    expect(at(`id ${ids.weekB}`)).toBeLessThan(at(`id ${ids.weekA}`));
    expect(at(`id ${ids.weekA}`)).toBeLessThan(at(`id ${ids.legacy}`));
    expect(text).toContain(`#### day · 2026-08-18 → 2026-08-19 · id ${ids.day}`);
    expect(at(`#### day · 2026-08-18`)).toBeGreaterThan(at(`id ${ids.weekB}`));
    // Orphan days (no parent link) are not top-level rungs — the spec
    // renders them only as children.
    expect(text).not.toContain(`id ${ids.orphan}`);
  });

  it("regenerates (overwrites) memory-map.md on every ritual run", async () => {
    const roleDir = join(dir, "role");
    mkdirSync(roleDir, { recursive: true });
    const events = openEvents(join(dir, "e.db"));
    const memory = openMemory(join(dir, "m.db"));
    const semantic = openSemantic(join(dir, "MEMORY.md"));
    const ins = () => events
      .prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 't', 'action', '{}')")
      .run(new Date().toISOString());
    ins();
    llm.respondWith({ learnings: "- I noticed a pattern", rollup: "First week body." });
    await dreamOnce({ role: { ...role, dir: roleDir }, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    const mapPath = join(dir, "state", "memory-map.md");
    expect(existsSync(mapPath)).toBe(true);
    expect(readFileSync(mapPath, "utf8")).toContain("First week body.");
    expect(readFileSync(mapPath, "utf8")).not.toContain("## Queued promotions"); // nothing queued

    // Simulate staleness: junk appended + a second ritual run overwrites it.
    appendFileSync(mapPath, "STALE JUNK THAT MUST NOT SURVIVE\n");
    ins();
    llm.respondWith({ learnings: "- I noticed another pattern", rollup: "Second week body." });
    await dreamOnce({ role: { ...role, dir: roleDir }, events, memory, semantic, llm: llm.llm, log: new Log(events, "t") });
    const after = readFileSync(mapPath, "utf8");
    expect(after.match(/# Memory map — t/g)).toHaveLength(1); // one header — overwritten, not appended
    expect(after).toContain("Second week body.");
    expect(after).toContain("First week body."); // prior rungs remain in the db
    expect(after).not.toContain("STALE JUNK");
  });

  it("caps the rendered queue at 20 and counts the overflow", () => {
    const memory = openMemory(join(dir, "m.db"));
    memory.exec(`
      CREATE TABLE IF NOT EXISTS memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, tag TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
    const ins = memory.prepare(`INSERT INTO memory_versions (ts, tag, body) VALUES (?, ?, ?)`);
    for (let i = 0; i < 23; i++) ins.run("2026-08-27T03:00:00.000Z", `dream-2026-08-${String(i).padStart(2, "0")}-candidate`, "- Candidate.");
    const text = writeMemoryMap(memory, { role: { dir: join(dir, "role"), name: "t" } });
    expect(text.match(/- `dream-/g)).toHaveLength(20); // newest 20 listed
    expect(text).toContain("… and 3 older candidate(s)");
  });
});

describe("rollup input compaction exclusion (AIC-131)", () => {
  it("classifies retrieval-output note events by their payload tool", () => {
    const note = (tool: string) => JSON.stringify({ tool, outcome: { hits: ["remembered material"] }, step: 1 });
    expect(isRetrievalOutputEvent({ kind: "note", payload: note("memory.walk") })).toBe(true);
    expect(isRetrievalOutputEvent({ kind: "note", payload: note("memory.search") })).toBe(true);
    expect(isRetrievalOutputEvent({ kind: "note", payload: note("memory.recall") })).toBe(true);
    expect(isRetrievalOutputEvent({ kind: "note", payload: note("memory.notes_read") })).toBe(true);
    // Other tools' note events carry action results, not retrieved memory.
    expect(isRetrievalOutputEvent({ kind: "note", payload: note("linear.comment") })).toBe(false);
    // Lived-event kinds are never retrieval output, whatever the payload.
    expect(isRetrievalOutputEvent({ kind: "action", payload: note("memory.walk") })).toBe(false);
    expect(isRetrievalOutputEvent({ kind: "deliberate", payload: "not json" })).toBe(false);
    expect(isRetrievalOutputEvent({ kind: "note", payload: "{not json" })).toBe(false);
  });

  it("rollupInputRows excludes retrieval outputs and keeps lived events", () => {
    const events = openEvents(join(dir, "e.db"));
    const ins = (kind: string, payload: string) => Number(
      events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 't', ?, ?)")
        .run(new Date().toISOString(), kind, payload).lastInsertRowid
    );
    const walkNote = ins("note", JSON.stringify({ tool: "memory.walk", outcome: { trace: "remembered" }, step: 1 }));
    const recallNote = ins("note", JSON.stringify({ tool: "memory.recall", outcome: "remembered paragraph", step: 2 }));
    const otherNote = ins("note", JSON.stringify({ tool: "linear.comment", outcome: { ok: true }, step: 3 }));
    const action = ins("action", JSON.stringify({ tool: "linear.comment", input: { issueId: "ILO-9" } }));
    const deliberation = ins("deliberate", JSON.stringify({ reason: "triaged ILO-9", thoughts: null }));

    const rows = rollupInputRows(events, new Date(Date.now() - 86_400_000).toISOString());
    const got = rows.map((r) => r.id);
    expect(got).toContain(action);
    expect(got).toContain(deliberation);
    expect(got).not.toContain(walkNote);
    expect(got).not.toContain(recallNote);
    expect(got).not.toContain(otherNote); // note kind stays out of the rollup input
  });

  it("keeps RETRIEVAL_TOOLS aligned with the registered memory tools", () => {
    // Every excluded name must be a real tool, so a rename breaks here
    // instead of silently un-excluding a retrieval tool.
    const registered = new Set([...memoryTools, ...memWalkTools].map((t) => t.name));
    for (const name of Object.keys(RETRIEVAL_TOOLS)) {
      expect(registered.has(name)).toBe(true);
    }
    // The write-side memory tools are not retrieval — they must stay in.
    expect(RETRIEVAL_TOOLS["memory.note"]).toBeUndefined();
    expect(RETRIEVAL_TOOLS["memory.note_project"]).toBeUndefined();
    expect(RETRIEVAL_TOOLS["memory.note_person"]).toBeUndefined();
  });
});
