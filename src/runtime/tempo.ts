// Self-awareness sensors. Rather than mechanically throttle the coworker, we
// feed it its own tempo (recent action rate) and budget (recent LLM cost) so
// the model reasons about pacing as part of deliberation.

import type { DatabaseSync } from "node:sqlite";

export interface TempoSnapshot {
  actionsLast1h: number;
  actionsLast24h: number;
  noopRatioLast100Ticks: number;      // fraction of last 100 ticks that were noops
  secondsSinceLastAction: number | null;
  secondsSinceLastPerceptionChange: number | null;
}

export function readTempo(events: DatabaseSync): TempoSnapshot {
  const now = Date.now();
  const cutoff1h = new Date(now - 3600_000).toISOString();
  const cutoff24h = new Date(now - 86400_000).toISOString();

  const actions1h = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'action' AND ts >= ?`)
    .get(cutoff1h) as { n: number }).n;
  const actions24h = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'action' AND ts >= ?`)
    .get(cutoff24h) as { n: number }).n;

  const last100 = events
    .prepare(
      `SELECT payload FROM events WHERE kind = 'deliberate' ORDER BY id DESC LIMIT 100`
    )
    .all() as { payload: string }[];
  const noops = last100.filter((r) => {
    try { return JSON.parse(r.payload).choice === "noop"; } catch { return false; }
  }).length;
  const noopRatio = last100.length ? noops / last100.length : 0;

  const lastAction = events
    .prepare(`SELECT ts FROM events WHERE kind = 'action' ORDER BY id DESC LIMIT 1`)
    .get() as { ts: string } | undefined;
  const secSinceAction = lastAction
    ? Math.floor((now - Date.parse(lastAction.ts)) / 1000)
    : null;

  return {
    actionsLast1h: actions1h,
    actionsLast24h: actions24h,
    noopRatioLast100Ticks: Number(noopRatio.toFixed(2)),
    secondsSinceLastAction: secSinceAction,
    secondsSinceLastPerceptionChange: null, // set by caller after hashing perception
  };
}

export interface BudgetSnapshot {
  llmCallsToday: number;
  deliberateErrorsToday: number;
}

export function readBudget(events: DatabaseSync): BudgetSnapshot {
  const cutoff = new Date(Date.now() - 86400_000).toISOString();
  const calls = (events
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE kind IN ('deliberate', 'deliberate.error') AND ts >= ?`
    )
    .get(cutoff) as { n: number }).n;
  const errors = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'deliberate.error' AND ts >= ?`)
    .get(cutoff) as { n: number }).n;
  return { llmCallsToday: calls, deliberateErrorsToday: errors };
}

// Extract the "Tempo" section from RITUALS.md, so the coworker sees its own
// expected cadence alongside its observed cadence.
export function extractTempoGuidance(ritualsMd: string): string {
  const m = ritualsMd.match(/^#+\s*Tempo[\s\S]*?(?=\n#+\s|\n*$)/im);
  return m ? m[0].trim() : "";
}
