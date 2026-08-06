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
import { redactString } from "./secret_redaction.ts";

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
  // Set of literal secret values to scrub verbatim from anything about to
  // be persisted or printed. Typically the values of every env var whose
  // name matches isCredentialName(); the constructor accepts a pre-built
  // set (see knownSecretsFrom) so callers control what gets scrubbed.
  private knownSecrets: ReadonlySet<string> | undefined;

  constructor(db: DatabaseSync, coworker: string, opts: { streamPath?: string; highlightPath?: string; knownSecrets?: ReadonlySet<string> } = {}) {
    this.db = db;
    this.coworker = coworker;
    this.streamPath = opts.streamPath ?? null;
    this.highlightPath = opts.highlightPath ?? null;
    this.knownSecrets = opts.knownSecrets;
  }

  event(kind: EventKind, payload: unknown): void {
    const ts = new Date().toISOString();
    // Redact secrets before persistence — a tool's error message might
    // echo the API key that was rejected, and once it's in events.db
    // every future reflect / metrics scrape / dashboard sees it.
    const serialized = redactString(JSON.stringify(payload ?? null), this.knownSecrets);
    retrySync(() =>
      this.db
        .prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
        .run(ts, this.coworker, kind, serialized)
    );
  }

  // Full stream — every tick, quiet or not. High volume; use for debugging.
  stream(line: string): void {
    const safe = redactString(line, this.knownSecrets);
    const formatted = this.formatLine(safe, "stream");
    process.stdout.write(formatted);
    if (this.streamPath) { try { appendFileSync(this.streamPath, formatted); } catch {} }
  }

  // Highlights — actions, boundary blocks, errors, escalations, wake events,
  // rituals. Skips per-tick noise. Written to BOTH stream and highlights so
  // one file gives you the full story.
  highlight(line: string): void {
    const safe = redactString(line, this.knownSecrets);
    const formatted = this.formatLine(safe, "highlight");
    process.stdout.write(formatted);
    if (this.highlightPath) { try { appendFileSync(this.highlightPath, formatted); } catch {} }
    if (this.streamPath)    { try { appendFileSync(this.streamPath, formatted); } catch {} }
  }

  // AIC-61 — respect LOG_FORMAT=json for ingestion into Loki/Grafana/Datadog.
  // Default remains human-readable text so `tail -f` is still pleasant.
  private formatLine(line: string, level: "stream" | "highlight"): string {
    if (process.env.LOG_FORMAT === "json") {
      return JSON.stringify({
        ts: new Date().toISOString(),
        coworker: this.coworker,
        level,
        msg: line,
      }) + "\n";
    }
    const t = new Date().toISOString().slice(11, 19);
    return `[${t}] ${this.coworker} ${line}\n`;
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
