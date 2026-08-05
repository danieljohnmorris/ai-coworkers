// Sensor circuit breaker. If a sensor errors N ticks in a row, quarantine it
// for a cooldown window (skip calling it entirely) so we don't burn LLM
// tokens and API quota deliberating with broken perception. Auto-retries
// after cooldown expires; a successful call resets the counter.

const DEFAULT_TRIP = 5;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

interface State { consecutiveErrors: number; quarantinedUntil: number }

const state = new Map<string, State>();

export function shouldSkip(sensor: string, now = Date.now()): boolean {
  const s = state.get(sensor);
  return !!s && s.quarantinedUntil > now;
}

export function recordSuccess(sensor: string): void {
  state.delete(sensor);
}

export function recordError(sensor: string, now = Date.now(), trip = DEFAULT_TRIP, cooldownMs = DEFAULT_COOLDOWN_MS): { quarantined: boolean } {
  const cur = state.get(sensor) ?? { consecutiveErrors: 0, quarantinedUntil: 0 };
  cur.consecutiveErrors++;
  if (cur.consecutiveErrors >= trip) {
    cur.quarantinedUntil = now + cooldownMs;
    state.set(sensor, cur);
    return { quarantined: true };
  }
  state.set(sensor, cur);
  return { quarantined: false };
}

export function _resetForTests(): void {
  state.clear();
}
