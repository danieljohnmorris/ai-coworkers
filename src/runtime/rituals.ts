// Ritual scheduler. Rituals are recurring behaviors (weekly dreaming, daily
// journal, morning summary) declared implicitly by name + cadence. We track
// last-run per ritual in the events table and fire when due. Missed windows
// are simply the next check that's past-due — no catch-up storms.

import type { DatabaseSync } from "node:sqlite";

export type RitualCadence =
  | { kind: "daily"; hourUTC: number; minuteUTC?: number }
  | { kind: "weekly"; weekdayUTC: number; hourUTC: number }        // 0 = Sun
  | { kind: "hourly" }
  | { kind: "every"; ms: number };

export interface RitualDef {
  name: string;                                       // e.g. "reflect.weekly"
  cadence: RitualCadence;
  run: () => Promise<void>;
}

export interface DueRitual {
  name: string;
}

// Persist ritual runs by writing an event kind="ritual.run" with the name.
// This means we lean on the same events db that FTS/tempo already read.
export function lastRun(events: DatabaseSync, name: string): Date | null {
  const row = events
    .prepare(
      `SELECT ts FROM events WHERE kind = 'ritual.run'
       AND json_extract(payload, '$.name') = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(name) as { ts: string } | undefined;
  return row ? new Date(row.ts) : null;
}

export function markRun(events: DatabaseSync, name: string, coworker: string, extra: unknown = {}): void {
  events
    .prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, 'ritual.run', ?)`)
    .run(new Date().toISOString(), coworker, JSON.stringify({ name, ...(extra as object) }));
}

export function isDue(cadence: RitualCadence, last: Date | null, now: Date): boolean {
  switch (cadence.kind) {
    case "hourly": {
      if (!last) return true;
      return now.getTime() - last.getTime() >= 3600_000;
    }
    case "every": {
      if (!last) return true;
      return now.getTime() - last.getTime() >= cadence.ms;
    }
    case "daily": {
      // Due if the scheduled hour has passed today and we haven't run today.
      const scheduled = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        cadence.hourUTC, cadence.minuteUTC ?? 0, 0
      ));
      if (now < scheduled) return false;
      if (!last) return true;
      return last < scheduled;
    }
    case "weekly": {
      // Due if today matches weekdayUTC, scheduled hour passed, and last run
      // was more than 24h ago (avoids double-firing within the same hour).
      if (now.getUTCDay() !== cadence.weekdayUTC) return false;
      const scheduled = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        cadence.hourUTC, 0, 0
      ));
      if (now < scheduled) return false;
      if (!last) return true;
      return now.getTime() - last.getTime() >= 24 * 3600_000;
    }
  }
}

export async function runDue(
  rituals: RitualDef[],
  events: DatabaseSync,
  coworker: string,
  now = new Date()
): Promise<DueRitual[]> {
  const fired: DueRitual[] = [];
  for (const r of rituals) {
    if (isDue(r.cadence, lastRun(events, r.name), now)) {
      try {
        await r.run();
        markRun(events, r.name, coworker, { ok: true });
        fired.push({ name: r.name });
      } catch (err) {
        markRun(events, r.name, coworker, { ok: false, error: String(err) });
        fired.push({ name: r.name });
      }
    }
  }
  return fired;
}
