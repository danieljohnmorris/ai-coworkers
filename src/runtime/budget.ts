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

export function extractWindowCap(boundariesMd: string): number | null {
  const m = boundariesMd.match(/max\s+llm\s+calls\s+per\s+(\d+)\s*h\s*window\s*:\s*(\d+)/i);
  return m ? Number(m[2]) : null;
}

export function extractWindowMinutes(boundariesMd: string): number {
  const m = boundariesMd.match(/llm\s+calls\s+per\s+(\d+)\s*h\s*window/i);
  return m ? Number(m[1]) * 60 : 5 * 60;    // default 5h to match Ollama Cloud's reset
}

export interface BudgetGate {
  callsToday: number;
  dailyCap: number;
  overDailyBudget: boolean;
  minutesUntilDailyReset: number;

  // Rolling window (matches provider limits like Ollama Cloud's 5h window).
  callsInWindow: number;
  windowCap: number | null;
  windowMinutes: number;
  pctWindowUsed: number;
  overWindowBudget: boolean;
}

export function checkBudget(
  events: DatabaseSync,
  dailyCap: number,
  windowCap: number | null,
  windowMinutes: number,
  now = new Date()
): BudgetGate {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const callsToday = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('deliberate','deliberate.error') AND ts >= ?`)
    .get(startOfDay) as { n: number }).n;
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const windowStart = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
  const callsInWindow = (events
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('deliberate','deliberate.error') AND ts >= ?`)
    .get(windowStart) as { n: number }).n;

  const effectiveWindowCap = windowCap ?? Math.max(1, Math.floor(dailyCap * windowMinutes / (24 * 60)));
  const pctWindowUsed = Math.floor((callsInWindow / effectiveWindowCap) * 100);

  return {
    callsToday,
    dailyCap,
    overDailyBudget: callsToday >= dailyCap,
    minutesUntilDailyReset: Math.max(0, Math.floor((nextReset.getTime() - now.getTime()) / 60_000)),
    callsInWindow,
    windowCap: effectiveWindowCap,
    windowMinutes,
    pctWindowUsed,
    overWindowBudget: callsInWindow >= effectiveWindowCap,
  };
}
