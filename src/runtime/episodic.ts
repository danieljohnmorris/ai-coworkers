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
//
// Design choice: plain (contentful) FTS5 rather than external-content, because
// node's built-in sqlite ships an FTS5 build that misbehaves with the external
// content + rebuild flow. Doubles storage for the payload column, which is
// acceptable — events are small JSON blobs and the compaction ritual will
// prune them regularly.
export function initEpisodic(events: DatabaseSync): void {
  events.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      event_id UNINDEXED,
      ts UNINDEXED,
      kind,
      payload,
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts (event_id, ts, kind, payload)
      VALUES (new.id, new.ts, new.kind, new.payload);
    END;
    -- events_ad mirrors the hot table only: archived rows (events_archive) are intentionally outside FTS until AIC-128 adds navigation.
    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      DELETE FROM events_fts WHERE event_id = old.id;
    END;
  `);
  // Backfill: if events exist but FTS is empty, copy them in.
  const eventCount = (events.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const ftsCount = (events.prepare(`SELECT COUNT(*) AS n FROM events_fts`).get() as { n: number }).n;
  if (eventCount > 0 && ftsCount === 0) {
    events.exec(`
      INSERT INTO events_fts (event_id, ts, kind, payload)
      SELECT id, ts, kind, payload FROM events
    `);
  }
}

// Sanitize a user-supplied FTS5 query. FTS5's query grammar treats hyphens,
// dots, and column names specially, so bare identifiers like "ILO-509" break.
// We quote each whitespace-separated token as an FTS5 phrase, which is both
// safe and does what users mean.
function sanitizeQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      // Already-quoted phrases pass through.
      if (/^".*"$/.test(tok)) return tok;
      // Escape embedded double-quotes per FTS5 rules ("" is an escaped ").
      return `"${tok.replace(/"/g, '""')}"`;
    })
    .join(" ");
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
  const safe = sanitizeQuery(query);
  if (!safe) return [];
  const rows = events
    .prepare(
      `SELECT event_id AS id, ts, kind,
              snippet(events_fts, 3, '[', ']', '…', 24) AS snippet
       FROM events_fts
       WHERE events_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(safe, limit) as EpisodicHit[];
  return rows;
}
