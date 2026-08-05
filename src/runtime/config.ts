// Central config for all tunable runtime values. Every knob a human might
// want to twist lives here. Env vars override defaults. Import as `cfg`
// where a value is needed, so the whole system reads from one place.

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined ? def : Number(v);
}

export const cfg = {
  // --- Ticking ---
  tickIntervalMs: num("TICK_INTERVAL_MS", 5 * 60_000),
  maxTickIntervalMs: num("MAX_TICK_INTERVAL_MS", 30 * 60_000),
  maxToolsPerTick: num("MAX_TOOLS_PER_TICK", 8),

  // --- Wake endpoint (event-driven ticks) ---
  wakePort: num("WAKE_PORT", 0),

  // --- Perception truncation (what the model sees) ---
  priorStepOutcomeMaxChars: num("PRIOR_STEP_OUTCOME_MAX_CHARS", 8000),
  priorStepInputMaxChars:   num("PRIOR_STEP_INPUT_MAX_CHARS", 400),
  sensorPayloadMaxChars:    num("SENSOR_PAYLOAD_MAX_CHARS", 4000),
  recentActionsMaxChars:    num("RECENT_ACTIONS_MAX_CHARS", 20_000),
  highlightsTailLines:      num("HIGHLIGHTS_TAIL_LINES", 20),
  recentThoughtsLimit:      num("RECENT_THOUGHTS_LIMIT", 8),

  // --- Memory caps ---
  semanticMemoryCapChars: num("SEMANTIC_MEMORY_CAP_CHARS", 2048),
  entityCapChars:         num("ENTITY_CAP_CHARS", 4096),

  // --- Reliability ---
  circuitTripAfterErrors: num("CIRCUIT_TRIP_AFTER_ERRORS", 5),
  circuitCooldownMs:      num("CIRCUIT_COOLDOWN_MS", 15 * 60_000),
  budgetDefaultDailyCap:  num("BUDGET_DEFAULT_DAILY_CAP", 5000),

  // --- Reflection / journal / retention ---
  reflectRetentionDays:   num("REFLECT_RETENTION_DAYS", 30),
  reflectWindowDays:      num("REFLECT_WINDOW_DAYS", 7),

  // --- Sensor cache TTLs (ms) per prefix. Not overridable via env because
  // per-tool tuning happens by editing the tool. Kept here for visibility.
  sensorCacheTtlMs: {
    "linear.workspace_snapshot": 24 * 3600_000,
    "linear.": 5 * 60_000,
    "slack.": 60_000,
    "github.": 5 * 60_000,
    "gmail.": 5 * 60_000,
    "gdocs.": 10 * 60_000,
  } as Record<string, number>,
};

// Standard suffix appended when a value has been sliced. The model can look
// for this to know it should narrow the query rather than doubt itself.
export const TRUNCATION_MARKER = "[…truncated — call again with a narrower query if you need the rest]";

// Slice a string to `max` chars, appending the truncation marker if it was
// actually cut. `max` includes the marker's length.
export function truncated(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = Math.max(0, max - TRUNCATION_MARKER.length);
  return s.slice(0, room) + TRUNCATION_MARKER;
}
