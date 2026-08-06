// AIC-62 — per-external-API rate-limit awareness. Independent from the
// LLM budget (budget.ts) and the per-tool circuit breaker (circuit.ts):
//
//   circuit.ts — trips on repeated ERRORS from a single tool (e.g. bad
//                query, network flake). Cooldown is fixed by config.
//   budget.ts  — enforces our OWN daily/window cap on LLM calls. Nothing
//                to do with the external service.
//   rate_limits.ts (this) — tracks WHEN an external service told us
//                "you're going too fast" (HTTP 429 or Retry-After header)
//                and quarantines that prefix until the cooldown ends.
//
// The tick loop consults this module before invoking any sensor or tool
// so we don't ram a 429'd service repeatedly. The current state also
// gets surfaced in perception so the model can plan around it ("linear
// is rate-limited until 15:22, focus on github work").

interface RateLimitEntry {
  prefix: string;             // tool prefix (e.g. "linear", "slack")
  until: number;              // epoch ms — rate-limit lifted at
  reason: string;             // e.g. "429 from linear.new_issues"
}

const state = new Map<string, RateLimitEntry>();

// Record a rate-limit hit. Prefer the Retry-After hint from the service;
// otherwise fall back to a sensible default (60s). Prefix = the first
// dotted segment of the tool name.
export function recordRateLimit(toolName: string, retryAfterSec?: number, reason?: string): void {
  const prefix = toolName.split(".")[0];
  const wait = Math.max(5, Math.min(retryAfterSec ?? 60, 3600));
  state.set(prefix, {
    prefix,
    until: Date.now() + wait * 1000,
    reason: reason ?? `${toolName} rate-limited`,
  });
}

// Extract a Retry-After hint from a Response object (or plain
// number-of-seconds header value). Falls back to undefined if not present.
export function retryAfterFrom(headers: Headers | Record<string, string | undefined>): number | undefined {
  const raw = headers instanceof Headers
    ? headers.get("retry-after")
    : (headers["retry-after"] ?? headers["Retry-After"]);
  if (!raw) return undefined;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;
  // HTTP date form (rare). Return seconds until that time.
  const asDate = Date.parse(String(raw));
  if (Number.isFinite(asDate)) return Math.max(0, Math.floor((asDate - Date.now()) / 1000));
  return undefined;
}

// Is a tool prefix currently rate-limited? Returns the remaining seconds
// if so (rounded up), or 0 if it's clear.
export function rateLimitRemaining(toolName: string, now = Date.now()): number {
  const prefix = toolName.split(".")[0];
  const entry = state.get(prefix);
  if (!entry) return 0;
  if (entry.until <= now) { state.delete(prefix); return 0; }
  return Math.ceil((entry.until - now) / 1000);
}

// Snapshot for perception — list active limits with human-readable
// "until" timestamps, ISO 8601. Empty when nothing is rate-limited.
export function activeRateLimits(now = Date.now()): { prefix: string; untilIso: string; reason: string }[] {
  const out: { prefix: string; untilIso: string; reason: string }[] = [];
  for (const entry of state.values()) {
    if (entry.until <= now) { state.delete(entry.prefix); continue; }
    out.push({
      prefix: entry.prefix,
      untilIso: new Date(entry.until).toISOString(),
      reason: entry.reason,
    });
  }
  return out;
}

// Test helper — clear state between tests.
export function _resetRateLimitsForTests(): void { state.clear(); }
