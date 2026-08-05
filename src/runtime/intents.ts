// AIC-42 — Intent matcher. Promises with an event-conditional trigger
// (e.g. "reporter replies within 24h") only fire when the runtime notices
// a matching event. Runs once per tick, cheap: scans the last N events
// against each pending promise's trigger text.
//
// Format of `trigger` field:
//   - "reply on ISSUE-42"                — fires when a comment appears
//   - "any new issue in ILO"             — fires when linear.new_issues has ILO rows
//   - "mention of ILO-42"                — fires when the identifier appears anywhere
//   - "before Fri 18:00"                 — falls through to time-based (fire_after)
//
// Deliberately shallow: substring + identifier match. Complex patterns can
// be added by making the trigger a JSON blob and dispatching on kind, later.

import type { DatabaseSync } from "node:sqlite";
import { pendingPromises, setPromiseStatus, type Promise_ } from "./memory.ts";

export interface FiredIntent {
  id: number;
  trigger: string;
  action: string;
  matchedEvent?: { ts: string; kind: string };
}

export function matchIntents(
  memory: DatabaseSync,
  events: DatabaseSync,
  now = new Date()
): FiredIntent[] {
  const fired: FiredIntent[] = [];
  const promises = pendingPromises(memory, now);
  if (!promises.length) return fired;

  // Get last hour of events as a rolling window to match against.
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const recent = events
    .prepare(`SELECT ts, kind, payload FROM events WHERE ts >= ? ORDER BY id DESC LIMIT 200`)
    .all(hourAgo) as { ts: string; kind: string; payload: string }[];

  for (const p of promises) {
    const match = findMatch(p, recent);
    if (match) {
      setPromiseStatus(memory, p.id, "fired");
      fired.push({ id: p.id, trigger: p.trigger, action: p.action, matchedEvent: match });
    }
  }
  return fired;
}

function findMatch(
  p: Promise_,
  recent: { ts: string; kind: string; payload: string }[]
): { ts: string; kind: string } | undefined {
  const trigger = p.trigger.toLowerCase();
  // Extract any ticket-style identifiers from the trigger (ILO-42, AIC-36).
  const ids = (p.trigger.match(/\b[A-Z]{2,4}-\d+\b/g) ?? []);
  for (const e of recent) {
    const hay = (e.kind + " " + e.payload).toLowerCase();
    // Match if trigger contains an identifier AND that identifier appears in event
    if (ids.some((id) => hay.includes(id.toLowerCase()))) {
      return { ts: e.ts, kind: e.kind };
    }
    // Or if key trigger words appear
    const keywords = ["reply", "comment", "mention"];
    for (const k of keywords) {
      if (trigger.includes(k) && hay.includes(k)) return { ts: e.ts, kind: e.kind };
    }
  }
  return undefined;
}
