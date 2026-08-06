// AIC-80 — declarative rituals loaded from role/rituals/*.json instead of
// hard-coded in tick.ts. Fits the "edit markdown → restart → new behavior"
// thesis: adding or tuning a ritual is a config edit, not a code change.
//
// Schema (each file is one ritual):
//   {
//     "name": "reflect.weekly",                       // unique per coworker
//     "cadence": { "kind": "weekly", "weekdayUTC": 0, "hourUTC": 3 },
//     "action": "reflect",                            // one of the built-in
//                                                      // dispatchers below
//     "note": "…optional human-readable comment…"
//   }
//
// Cadence variants (from RitualCadence):
//   { "kind": "hourly" }
//   { "kind": "daily",  "hourUTC": N, "minuteUTC": M? }
//   { "kind": "weekly", "weekdayUTC": 0..6, "hourUTC": N }
//   { "kind": "every",  "ms": N }
//
// Actions must be one of the strings dispatched by tick.ts. Unknown action
// strings are rejected at load time so a typo doesn't silently disable a
// ritual.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RitualCadence } from "./rituals.ts";

export const KNOWN_ACTIONS = ["reflect", "journal", "role_audit", "health_snapshot"] as const;
export type RitualAction = (typeof KNOWN_ACTIONS)[number];

export interface RitualSpec {
  name: string;
  cadence: RitualCadence;
  action: RitualAction;
  note?: string;
}

export interface LoadResult {
  specs: RitualSpec[];
  errors: string[];
}

// Built-in defaults — used when the coworker has no role/rituals/ dir or
// the dir is empty. Matches the historical hard-coded rituals from tick.ts
// exactly so promoting an existing coworker doesn't change its behaviour.
export const BUILTIN_RITUALS: RitualSpec[] = [
  { name: "reflect.weekly",   cadence: { kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, action: "reflect" },
  { name: "journal.daily",    cadence: { kind: "daily",  hourUTC: 9 },                 action: "journal" },
  { name: "role.audit",       cadence: { kind: "daily",  hourUTC: 8 },                 action: "role_audit" },
  { name: "health.snapshot",  cadence: { kind: "hourly" },                              action: "health_snapshot" },
];

export function loadRituals(ritualsDir: string): LoadResult {
  const errors: string[] = [];
  if (!existsSync(ritualsDir)) return { specs: BUILTIN_RITUALS, errors };

  const files = readdirSync(ritualsDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) return { specs: BUILTIN_RITUALS, errors };

  const specs: RitualSpec[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(ritualsDir, f);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { errors.push(`${f}: bad JSON — ${err}`); continue; }

    const validated = validateRitual(raw, f);
    if ("error" in validated) { errors.push(`${f}: ${validated.error}`); continue; }
    if (seen.has(validated.spec.name)) {
      errors.push(`${f}: duplicate ritual name "${validated.spec.name}" (already seen)`);
      continue;
    }
    seen.add(validated.spec.name);
    specs.push(validated.spec);
  }
  return { specs, errors };
}

function validateRitual(raw: unknown, source: string): { spec: RitualSpec } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "not an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) return { error: "missing string 'name'" };
  if (!r.cadence || typeof r.cadence !== "object") return { error: "missing object 'cadence'" };
  if (typeof r.action !== "string") return { error: "missing string 'action'" };
  if (!(KNOWN_ACTIONS as readonly string[]).includes(r.action)) {
    return { error: `unknown action "${r.action}" (valid: ${KNOWN_ACTIONS.join(", ")})` };
  }
  const cadenceErr = validateCadence(r.cadence as Record<string, unknown>);
  if (cadenceErr) return { error: cadenceErr };
  const spec: RitualSpec = {
    name: r.name,
    cadence: r.cadence as RitualCadence,
    action: r.action as RitualAction,
    ...(typeof r.note === "string" ? { note: r.note } : {}),
  };
  void source;
  return { spec };
}

function validateCadence(c: Record<string, unknown>): string | null {
  switch (c.kind) {
    case "hourly": return null;
    case "daily": {
      if (typeof c.hourUTC !== "number" || c.hourUTC < 0 || c.hourUTC > 23) return "daily cadence needs numeric hourUTC in [0,23]";
      if (c.minuteUTC !== undefined && (typeof c.minuteUTC !== "number" || c.minuteUTC < 0 || c.minuteUTC > 59)) return "daily minuteUTC must be in [0,59]";
      return null;
    }
    case "weekly": {
      if (typeof c.weekdayUTC !== "number" || c.weekdayUTC < 0 || c.weekdayUTC > 6) return "weekly cadence needs weekdayUTC in [0,6]";
      if (typeof c.hourUTC !== "number" || c.hourUTC < 0 || c.hourUTC > 23) return "weekly cadence needs hourUTC in [0,23]";
      return null;
    }
    case "every": {
      if (typeof c.ms !== "number" || c.ms <= 0) return "every cadence needs positive ms";
      return null;
    }
    default: return `unknown cadence.kind: ${String(c.kind)}`;
  }
}
