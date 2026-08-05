// Tiered memory + promises. All sqlite, one file per coworker.
//   hot   — last N days of raw action log rows (via log.ts events table)
//   warm  — daily/weekly rollups written by the memory-compact ritual
//   cold  — long-term decision log, notable facts, people directory
// The compaction ritual (see rituals.ts) reads hot rows and writes warm rollups,
// then drops raw rows older than a retention window.

import { DatabaseSync } from "node:sqlite";

export function openMemory(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,          -- 'day' | 'week' | 'month'
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT
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
  return db;
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
