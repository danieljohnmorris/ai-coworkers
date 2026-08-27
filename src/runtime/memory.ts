// Tiered memory + promises. All sqlite, one file per coworker.
//   hot   — last N days of raw action log rows (via log.ts events table)
//   warm  — daily/weekly rollups written by the memory-compact ritual
//   cold  — long-term decision log, notable facts, people directory
// The compaction ritual (see rituals.ts) reads hot rows and writes warm rollups,
// then drops raw rows older than a retention window.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { Log } from "./log.ts";

export function openMemory(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,          -- 'day' | 'week' | 'month'
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      body TEXT NOT NULL,
      -- AIC-128 memory ladder: rung height (day=1, week=2, month=3), link to
      -- the coarser rollup above, and the raw-event id span this row distills
      -- (JSON [first_event_id, last_event_id]). NULL on rows written before
      -- the ladder existed — provenance is never synthesised (ADR-0008).
      level INTEGER,
      parent_id INTEGER REFERENCES rollups(id),
      source_range TEXT
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT,
      source_events TEXT             -- AIC-128: JSON event-id provenance, see recordDecision
    );

    CREATE TABLE IF NOT EXISTS people (
      handle TEXT PRIMARY KEY,       -- e.g. 'dan', '@dan_slack', 'dan@…'
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS promises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      trigger TEXT NOT NULL,         -- free-text or json
      action TEXT NOT NULL,          -- free-text or json
      fire_after TEXT,               -- ISO ts, optional
      status TEXT NOT NULL           -- pending | fired | expired | cancelled
    );
  `);
  // AIC-128 additive migration for databases created before the ladder
  // columns existed. Guarded by pragma table_info so reopening is a no-op;
  // pre-existing rows keep NULLs — legacy provenance is never backfilled.
  ensureColumn(db, "rollups", "level", "level INTEGER");
  ensureColumn(db, "rollups", "parent_id", "parent_id INTEGER REFERENCES rollups(id)");
  ensureColumn(db, "rollups", "source_range", "source_range TEXT");
  ensureColumn(db, "decisions", "source_events", "source_events TEXT");
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// AIC-128 write-time provenance validation: every event id cited by a rollup
// source_range or a decision's source_events must resolve against the hot
// events table OR the events_archive cold table (AIC-127). Callers write
// NULL provenance when this returns false — bad links are worse than none
// (ADR-0008).
export function eventIdsResolve(events: DatabaseSync, ids: number[]): boolean {
  if (ids.length === 0) return false;
  const hot = events.prepare(`SELECT 1 FROM events WHERE id = ?`);
  // The cold table may be missing on an events db that predates AIC-127;
  // ids not found in the hot table are then simply unresolved (NULL
  // provenance downstream), never a crash.
  let cold: StatementSync | null;
  try {
    cold = events.prepare(`SELECT 1 FROM events_archive WHERE id = ?`);
  } catch {
    cold = null;
  }
  return ids.every(
    (id) =>
      Number.isInteger(id) &&
      (hot.get(id) !== undefined || (cold !== null && cold.get(id) !== undefined))
  );
}

// AIC-128: decisions record the event ids they were distilled from. Up to
// 200 ids are stored as a plain JSON array; past that a decision effectively
// cites "the whole window", so we store {"span":[min,max]} instead — the
// object shape keeps a genuine two-element id list unambiguous for readers.
// Ids that do not resolve against events/events_archive yield NULL
// provenance plus a memory.compact log entry, never bad links (ADR-0008).
const SOURCE_EVENTS_CAP = 200;

export function recordDecision(
  memory: DatabaseSync,
  events: DatabaseSync,
  args: { summary: string; rationale?: string | null; sourceEventIds?: number[]; log?: Log }
): number {
  const ids = args.sourceEventIds ?? [];
  let sourceEvents: string | null = null;
  if (ids.length > 0) {
    let min = ids[0], max = ids[0];
    for (const id of ids) { if (id < min) min = id; if (id > max) max = id; }
    const overflow = ids.length > SOURCE_EVENTS_CAP;
    // Overflow spans are validated at their endpoints, same as rollup ranges.
    if (eventIdsResolve(events, overflow ? [min, max] : ids)) {
      sourceEvents = overflow ? JSON.stringify({ span: [min, max] }) : JSON.stringify(ids);
    } else {
      args.log?.event("memory.compact", {
        step: "provenance", ok: false,
        reason: "decision source_events did not resolve against events/events_archive — wrote NULL",
      });
    }
  }
  const info = memory
    .prepare(`INSERT INTO decisions (ts, summary, rationale, source_events) VALUES (?, ?, ?, ?)`)
    .run(new Date().toISOString(), args.summary, args.rationale ?? null, sourceEvents);
  return Number(info.lastInsertRowid);
}

export interface Promise_ {
  id: number;
  created_at: string;
  trigger: string;
  action: string;
  fire_after: string | null;
  status: "pending" | "fired" | "expired" | "cancelled";
}

export function pendingPromises(db: DatabaseSync, now: Date): Promise_[] {
  const rows = db
    .prepare(
      `SELECT * FROM promises
       WHERE status = 'pending'
         AND (fire_after IS NULL OR fire_after <= ?)
       ORDER BY id`
    )
    .all(now.toISOString()) as Promise_[];
  return rows;
}

export function addPromise(
  db: DatabaseSync,
  trigger: string,
  action: string,
  fireAfter: Date | null
): number {
  const info = db
    .prepare(
      `INSERT INTO promises (created_at, trigger, action, fire_after, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(
      new Date().toISOString(),
      trigger,
      action,
      fireAfter ? fireAfter.toISOString() : null
    );
  return Number(info.lastInsertRowid);
}

export function setPromiseStatus(
  db: DatabaseSync,
  id: number,
  status: Promise_["status"]
): void {
  db.prepare(`UPDATE promises SET status = ? WHERE id = ?`).run(status, id);
}

export function recentRollups(db: DatabaseSync, limit = 5): { period: string; body: string }[] {
  return db
    .prepare(`SELECT period, body FROM rollups ORDER BY id DESC LIMIT ?`)
    .all(limit) as { period: string; body: string }[];
}
