// Cheap in-memory cache so sensors that hit external APIs (Linear, Slack,
// GitHub) don't run every tick. Sensor tools may declare `minIntervalMs` on
// themselves via a convention: name suffix or a static property on the module.
// For v1 we use a name-based default table — trivially editable.

const DEFAULTS: Record<string, number> = {
  "linear.workspace_snapshot": 24 * 3600_000,  // once/day is plenty
  "linear.": 5 * 60_000,                       // other linear sensors: 5 min
  "slack.": 60_000,
  "github.": 5 * 60_000,
  "gmail.": 5 * 60_000,
  "gdocs.": 10 * 60_000,
};

const store = new Map<string, { at: number; value: unknown }>();

export function minInterval(sensorName: string): number {
  for (const prefix of Object.keys(DEFAULTS)) {
    if (sensorName.startsWith(prefix)) return DEFAULTS[prefix];
  }
  return 0;
}

export function getCached(sensorName: string, now: number): unknown | undefined {
  const entry = store.get(sensorName);
  if (!entry) return undefined;
  const ttl = minInterval(sensorName);
  if (ttl === 0) return undefined;
  if (now - entry.at > ttl) return undefined;
  return entry.value;
}

export function setCached(sensorName: string, value: unknown, now: number): void {
  store.set(sensorName, { at: now, value });
}
