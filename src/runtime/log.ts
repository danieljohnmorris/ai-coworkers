// Structured event log + two human/agent-readable text streams:
//   - stream.log      full narrative, one line per tick (quiet + noisy)
//   - highlights.log  condensed — actions, boundary blocks, errors, rituals,
//                     wake events. Skips per-tick noise. Used both by humans
//                     for a "what happened today" narrative and by the agent
//                     itself: the tick loop tails this file into perception
//                     instead of raw event JSON, saving tokens per turn.

import { DatabaseSync } from "node:sqlite";
import { retrySync } from "./sqlite-retry.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type EventKind =
  | "tick.start" | "tick.end"
  | "sensor.read" | "sensor.error"
  | "deliberate" | "deliberate.error" | "deliberate.rawoutput"
  | "action" | "action.error"
  | "boundary.block"
  | "hygiene.sweep" | "hygiene.reap"
  | "promise.add" | "promise.fire" | "promise.expire"
  | "memory.compact"
  | "perception.hash"
  | "ritual.run"
  | "tick.quiet"
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
  private streamPath: string | null;
  private highlightPath: string | null;

  constructor(db: DatabaseSync, coworker: string, opts: { streamPath?: string; highlightPath?: string } = {}) {
    this.db = db;
    this.coworker = coworker;
    this.streamPath = opts.streamPath ?? null;
    this.highlightPath = opts.highlightPath ?? null;
  }

  event(kind: EventKind, payload: unknown): void {
    const ts = new Date().toISOString();
    retrySync(() =>
      this.db
        .prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
        .run(ts, this.coworker, kind, JSON.stringify(payload ?? null))
    );
  }

  // Full stream — every tick, quiet or not. High volume; use for debugging.
  stream(line: string): void {
    const t = new Date().toISOString().slice(11, 19);
    const formatted = `[${t}] ${this.coworker} ${line}\n`;
    process.stdout.write(formatted);
    if (this.streamPath) { try { appendFileSync(this.streamPath, formatted); } catch {} }
  }

  // Highlights — actions, boundary blocks, errors, escalations, wake events,
  // rituals. Skips per-tick noise. Written to BOTH stream and highlights so
  // one file gives you the full story.
  highlight(line: string): void {
    const t = new Date().toISOString().slice(11, 19);
    const formatted = `[${t}] ${this.coworker} ${line}\n`;
    process.stdout.write(formatted);
    if (this.highlightPath) { try { appendFileSync(this.highlightPath, formatted); } catch {} }
    if (this.streamPath)    { try { appendFileSync(this.streamPath, formatted); } catch {} }
  }
}

// Tail the last N lines of the highlights file (or empty if missing). Cheap
// bounded read — used by the tick to hand the agent a compact "what I did
// recently" summary instead of raw event JSON.
export function tailHighlights(path: string, lines = 20): string {
  if (!existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    const arr = text.split(/\r?\n/).filter(Boolean);
    return arr.slice(-lines).join("\n");
  } catch {
    return "";
  }
}
