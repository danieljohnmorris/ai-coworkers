// Working-memory compaction. When the perception blob gets big — mostly from
// long recentActions or verbose sensor payloads — we replace the middle with
// a summarised placeholder while keeping the head (older context) and tail
// (most recent, most relevant) intact.
//
// This is purely a pre-prompt trim; nothing is written back to memory. The
// reflective ritual (weekly dreaming) is what actually distills long-term.

const DEFAULT_MAX_CHARS = 20_000;         // ~5k tokens
const HEAD_FRACTION = 0.15;
const TAIL_FRACTION = 0.55;

export function compactRecentActions<T>(actions: T[], maxChars = DEFAULT_MAX_CHARS): { compact: T[]; dropped: number } {
  const size = JSON.stringify(actions).length;
  if (size <= maxChars) return { compact: actions, dropped: 0 };

  // Keep the newest N such that the JSON stays under budget.
  const kept: T[] = [];
  let running = 2; // for the enclosing []
  for (let i = actions.length - 1; i >= 0; i--) {
    const chunk = JSON.stringify(actions[i]).length + 1;
    if (running + chunk > maxChars) break;
    kept.unshift(actions[i]);
    running += chunk;
  }
  return { compact: kept, dropped: actions.length - kept.length };
}

// Truncate any single sensor result whose JSON exceeds a per-sensor cap.
// Prevents one verbose sensor from crowding out everything else.
export function truncateSensorPayloads<T extends { name: string; result: unknown }>(
  sensors: T[],
  perSensorMaxChars = 4_000
): T[] {
  return sensors.map((s) => {
    const j = JSON.stringify(s.result);
    if (!j || j.length <= perSensorMaxChars) return s;
    return { ...s, result: { _truncated: true, _originalLength: j.length, preview: j.slice(0, perSensorMaxChars) + "…" } };
  });
}

export const _internals = { HEAD_FRACTION, TAIL_FRACTION, DEFAULT_MAX_CHARS };
