// AIC-46 — Retry wrapper for tool actions that hit external APIs. Only
// retries on transient errors (5xx status codes, ECONNRESET, ETIMEDOUT,
// Linear/Slack/GitHub rate-limit 429). Deterministic errors (400, 401,
// 403, 404) bail immediately.

const DEFAULT_ATTEMPTS = 3;
const BASE_MS = 500;

export async function retryAsync<T>(
  fn: () => Promise<T>,
  attempts = DEFAULT_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const wait = BASE_MS * 2 ** i + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export function isTransient(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  // HTTP status codes returned by our tool wrappers as "Linear 502: ..."
  if (/\b(429|5\d\d)\b/.test(msg)) return true;
  // Node network errors
  if (/(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE)/.test(msg)) return true;
  // Fetch abort / socket hang up
  if (/hang up|aborted/i.test(msg)) return true;
  return false;
}
