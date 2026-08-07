// Optional working-hours support for a coworker. See docs/coworker-builder-guide.md
// and the `work_hours` block in src/runtime/config-schema.json for the config
// surface. If the block is absent the coworker runs 24/7 and behaviour is
// unchanged.
//
// This module deliberately depends only on the built-in `Intl` API — no
// date library. Timezone conversion is performed via Intl.DateTimeFormat.

export type OutOfHoursMode = "webhook_only" | "reduced" | "normal";

export interface WorkHoursConfig {
  timezone?: string;
  days?: number[];
  start?: string;
  end?: string;
  out_of_hours: OutOfHoursMode;
  out_of_hours_interval_min?: number;
}

// Weekday label lookup, ISO 1..7 (Mon..Sun).
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function resolveTz(cfg: WorkHoursConfig): string {
  return cfg.timezone && cfg.timezone.length > 0
    ? cfg.timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Convert an absolute Date to the local wall-clock weekday+minutes in the
// configured timezone. Uses Intl.DateTimeFormat with `formatToParts` so we
// avoid any string-parsing fragility.
export function localWallClock(now: Date, timezone: string): {
  weekday: number; // 1=Mon..7=Sun
  minutes: number; // 0..1439
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  let hour = 0;
  let minute = 0;
  let wdStr = "Mon";
  for (const p of parts) {
    if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
    else if (p.type === "weekday") wdStr = p.value;
  }
  const wdMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return { weekday: wdMap[wdStr] ?? 1, minutes: hour * 60 + minute };
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(":");
  return Number(h) * 60 + Number(m);
}

export function isInHours(cfg: WorkHoursConfig | undefined, now: Date = new Date()): boolean {
  if (!cfg) return true;
  const tz = resolveTz(cfg);
  const { weekday, minutes } = localWallClock(now, tz);

  // Day restriction.
  if (cfg.days && cfg.days.length > 0) {
    if (!cfg.days.includes(weekday)) return false;
  }

  // Time restriction.
  if (cfg.start && cfg.end) {
    const start = parseHHMM(cfg.start);
    const end = parseHHMM(cfg.end);
    if (start === end) {
      // Zero-length window — never in hours.
      return false;
    }
    if (end > start) {
      // Same-day window; [start, end).
      return minutes >= start && minutes < end;
    }
    // Spanning midnight, e.g. 22:00-06:00. In-hours if >= start OR < end.
    return minutes >= start || minutes < end;
  }
  // Days matched (or no day restriction) and no time restriction → in.
  return true;
}

// Human-readable line for status.sh output.
// Example: "Mon-Fri 09:00-18:00 Europe/London (out-of-hours: webhook_only)"
export function describeHours(cfg: WorkHoursConfig | undefined): string {
  if (!cfg) return "24/7";
  const tz = resolveTz(cfg);
  const daysPart = describeDays(cfg.days);
  const timePart = cfg.start && cfg.end ? `${cfg.start}-${cfg.end}` : "any time";
  return `${daysPart} ${timePart} ${tz} (out-of-hours: ${cfg.out_of_hours})`;
}

function describeDays(days: number[] | undefined): string {
  if (!days || days.length === 0) return "every day";
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  // Detect a contiguous run.
  const isContiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (isContiguous && sorted.length > 1) {
    return `${WEEKDAY_SHORT[sorted[0]]}-${WEEKDAY_SHORT[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((d) => WEEKDAY_SHORT[d]).join(",");
}

// Compute the next Date at which the coworker will next transition into
// working hours, starting from `now`. Returns null if `cfg` is undefined
// (always in hours). Returns `now` when already in-hours.
//
// Strategy: snap directly to candidate `start` boundaries over the next
// 8 days rather than scanning at a fixed step. A 15-minute scan would
// miss narrow windows (e.g. start=09:00 end=09:10 hit at 09:11 would
// find 09:15 which is out-of-hours). We enumerate the `start` timestamp
// in the target timezone for each of the next 8 days, keep only those
// strictly > `now` and whose weekday is allowed, and return the earliest.
export function nextInHours(cfg: WorkHoursConfig | undefined, now: Date = new Date()): Date | null {
  if (!cfg) return null;
  if (isInHours(cfg, now)) return now;

  // Without an explicit start time, "next in-hours" means the next allowed
  // day at 00:00 local. If no day restriction either, we'd already be in-hours.
  const tz = resolveTz(cfg);
  const startMin = cfg.start ? parseHHMM(cfg.start) : 0;
  const allowedDay = (wd: number): boolean =>
    !cfg.days || cfg.days.length === 0 || cfg.days.includes(wd);

  let best: Date | null = null;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60_000);
    // Snap to that day's `start` (or 00:00) in the configured timezone.
    const candidate = wallClockToInstant(probe, tz, startMin);
    if (candidate.getTime() <= now.getTime()) continue;
    const wc = localWallClock(candidate, tz);
    if (!allowedDay(wc.weekday)) continue;
    // Sanity: the candidate should itself be in-hours. If not (edge cases
    // around DST-shifted start minutes, or a spanning-midnight window
    // where the "start" is actually the beginning of a period that
    // already began the previous day), fall back to the isInHours check.
    if (!isInHours(cfg, candidate)) continue;
    best = candidate;
    break;
  }
  return best;
}

// Given a Date, a target timezone, and a minute-of-day, return an absolute
// Date whose local wall-clock (in `timezone`) reads that minute-of-day on
// the same calendar day as the input's local date. Uses two Intl round-trips
// to solve for the UTC offset without pulling in a date library.
function wallClockToInstant(sameDayAs: Date, timezone: string, minuteOfDay: number): Date {
  // Step 1: get the local Y-M-D for the input date in the target tz.
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(sameDayAs);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const targetH = Math.floor(minuteOfDay / 60);
  const targetM = minuteOfDay % 60;
  // Step 2: first guess — treat local wall clock as UTC, then correct.
  const guess = Date.UTC(y, mo - 1, d, targetH, targetM, 0);
  // What does that guess actually read as in the target tz?
  const guessParts = dtf.formatToParts(new Date(guess));
  const gh = Number(guessParts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const gm = Number(guessParts.find((p) => p.type === "minute")?.value ?? "0");
  const offsetMin = (targetH * 60 + targetM) - (gh * 60 + gm);
  return new Date(guess + offsetMin * 60_000);
}
