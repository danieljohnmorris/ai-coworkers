// Episodic memory — full-text search across the coworker's own action log
// and rollups. Answers questions like "when did I last comment on ILO-509?"
// or "what did I decide about parser bugs last week?".
//
// Design note: FTS5 first, embeddings never (for now). Coworkers query by
// exact ticket IDs, PR numbers, handles, and channel names — token overlap
// wins over semantic similarity on that workload. See the memory research
// report; embedding-only recall was flagged as an anti-pattern.

import type { DatabaseSync } from "node:sqlite";

// Called once at startup on the events db. Creates the FTS5 mirror + triggers
// that keep it synced with the events table. Idempotent.
export function initEpisodic(events: DatabaseSync): void {
  events.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      ts UNINDEXED,
      kind,
      payload,
      content='events',
      content_rowid='id',
      tokenize = 'porter unicode61'
    );

    -- Keep FTS5 in sync with events. Use "external content" pattern so we
    -- don't duplicate storage.
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts (rowid, ts, kind, payload)
      VALUES (new.id, new.ts, new.kind, new.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts (events_fts, rowid, ts, kind, payload)
      VALUES ('delete', old.id, old.ts, old.kind, old.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts (events_fts, rowid, ts, kind, payload)
      VALUES ('delete', old.id, old.ts, old.kind, old.payload);
      INSERT INTO events_fts (rowid, ts, kind, payload)
      VALUES (new.id, new.ts, new.kind, new.payload);
    END;
  `);
  // Backfill: if events exist but FTS is empty, populate it once.
  const eventCount = (events.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const ftsCount = (events.prepare(`SELECT COUNT(*) AS n FROM events_fts`).get() as { n: number }).n;
  if (eventCount > 0 && ftsCount === 0) {
    events.exec(`INSERT INTO events_fts (rowid, ts, kind, payload)
                 SELECT id, ts, kind, payload FROM events`);
  }
}

export interface EpisodicHit {
  id: number;
  ts: string;
  kind: string;
  snippet: string;
}

// Search past events. FTS5 query syntax: bare words are AND'd; quotes for
// exact phrase; use "linear.comment" to filter by kind, or combine.
export function search(
  events: DatabaseSync,
  query: string,
  limit = 10
): EpisodicHit[] {
  if (!query || !query.trim()) return [];
  const rows = events
    .prepare(
      `SELECT rowid AS id, ts, kind,
              snippet(events_fts, 2, '[', ']', '…', 24) AS snippet
       FROM events_fts
       WHERE events_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as EpisodicHit[];
  return rows;
}
