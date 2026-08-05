// Hard daily LLM-call cap per coworker. Read the limit from BOUNDARIES.md
// ("Max LLM calls per day: N"); if breached, deliberation is skipped and
// the coworker enters a "sleep" state that only records a status event
// every ~hour until the cap resets at UTC midnight.

import type { DatabaseSync } from "node:sqlite";

const DEFAULT_CAP = 5000;

export function extractCallCap(boundariesMd: string): number {
  const m = boundariesMd.match(/max\s+llm\s+calls\s+per\s+day\s*:\s*(\d+)/i);
  return m ? Number(m[1]) : DEFAULT_CAP;
}

export interface BudgetGate {
  callsToday: number;
  cap: number;
  overBudget: boolean;
  minutesUntilReset: number;
}

export function checkBudget(events: DatabaseSync, cap: number, now = new Date()): BudgetGate {
  // "Today" = calendar day in UTC
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const callsToday = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('deliberate','deliberate.error') AND ts >= ?`)
    .get(startOfDay) as { n: number }).n;
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return {
    callsToday,
    cap,
    overBudget: callsToday >= cap,
    minutesUntilReset: Math.max(0, Math.floor((nextReset.getTime() - now.getTime()) / 60_000)),
  };
}
