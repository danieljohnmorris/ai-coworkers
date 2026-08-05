// Structured event log + human-readable stream log.
// Every tick, sensor read, deliberation, action, boundary block, hygiene
// sweep, and error goes to sqlite. A single-line stream summary goes to
// stdout for `journalctl` consumption.

import { DatabaseSync } from "node:sqlite";

export type EventKind =
  | "tick.start" | "tick.end"
  | "sensor.read" | "sensor.error"
  | "deliberate" | "deliberate.error"
  | "action" | "action.error"
  | "boundary.block"
  | "hygiene.sweep" | "hygiene.reap"
  | "promise.add" | "promise.fire" | "promise.expire"
  | "memory.compact"
  | "note";

export interface EventRow {
  ts: string;
  coworker: string;
  kind: EventKind;
  payload: unknown;
}

export function openEvents(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      coworker TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);
  `);
  return db;
}

export class Log {
  private db: DatabaseSync;
  private coworker: string;
  constructor(db: DatabaseSync, coworker: string) {
    this.db = db;
    this.coworker = coworker;
  }

  event(kind: EventKind, payload: unknown): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(ts, this.coworker, kind, JSON.stringify(payload ?? null));
  }

  stream(line: string): void {
    const t = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${t}] ${this.coworker} ${line}\n`);
  }
}
