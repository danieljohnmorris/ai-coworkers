// Tiny retry helper for SQLite writes that occasionally lose to a "database
// is locked" race — e.g. when the reflective ritual is compacting while the
// tick tries to log an event. Exponential backoff, bounded.

const DEFAULT_ATTEMPTS = 5;
const BASE_MS = 25;

export function retrySync<T>(fn: () => T, attempts = DEFAULT_ATTEMPTS): T {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (!/(SQLITE_BUSY|SQLITE_LOCKED|database is locked)/i.test(msg)) throw err;
      const wait = BASE_MS * 2 ** i;
      const end = Date.now() + wait;
      while (Date.now() < end) { /* busy sleep — Node has no sync setTimeout */ }
    }
  }
  throw lastErr;
}
