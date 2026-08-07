// Per-coworker behavioural config loader.
//
// Reads coworkers/<name>/config.json, validates it against
// src/runtime/config-schema.json, and returns a fully-populated
// CoworkerConfig. For each knob not set in config.json, falls back to the
// corresponding env var (upper-snake-case of the config key). For each knob
// unset in both, uses the schema's default.
//
// Env fallback is preserved so existing operators keep working, but a
// one-time deprecation warning is logged for every env-fallback hit. If
// both config.json AND env set the same knob, config.json wins and a
// warning is logged.
//
// See docs/adr/0007-config-file-vs-env-vars.md for why this split exists.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { WorkHoursConfig } from "./work_hours.ts";

export interface CoworkerConfig {
  wake_mode: "tick" | "webhook" | "both";
  extract_entities: boolean;
  max_tools_per_tick: number;
  pii_mask: boolean;
  note_require_signed: boolean;
  work_hours?: WorkHoursConfig;
}

// Which config key maps to which legacy env var. The env var name is the
// upper-snake-case of the config key.
const ENV_MAP: Record<keyof CoworkerConfig, string> = {
  wake_mode: "WAKE_MODE",
  extract_entities: "EXTRACT_ENTITIES",
  max_tools_per_tick: "MAX_TOOLS_PER_TICK",
  pii_mask: "PII_MASK",
  note_require_signed: "NOTE_REQUIRE_SIGNED",
};

let cachedSchema: Record<string, unknown> | null = null;
function loadSchema(): Record<string, unknown> {
  if (cachedSchema) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "config-schema.json");
  cachedSchema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return cachedSchema;
}

// One-shot dedupe for deprecation warnings across the process lifetime —
// startup log lines shouldn't repeat if loadCoworkerConfig is called twice.
const warnedKeys = new Set<string>();

function coerceEnv(key: keyof CoworkerConfig, raw: string): unknown {
  // Env values are always strings; coerce to the schema's target type.
  switch (key) {
    case "wake_mode":
      return raw;
    case "extract_entities":
    case "pii_mask":
    case "note_require_signed":
      return raw === "1" || raw.toLowerCase() === "true";
    case "max_tools_per_tick": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw; // let the schema catch garbage
    }
  }
}

function defaults(): CoworkerConfig {
  const schema = loadSchema();
  const props = schema.properties as Record<string, { default: unknown }>;
  return {
    wake_mode: props.wake_mode.default as CoworkerConfig["wake_mode"],
    extract_entities: props.extract_entities.default as boolean,
    max_tools_per_tick: props.max_tools_per_tick.default as number,
    pii_mask: props.pii_mask.default as boolean,
    note_require_signed: props.note_require_signed.default as boolean,
  };
}

export interface LoadCoworkerConfigOptions {
  // Injected logger so callers can route warnings to their own stream.
  // Defaults to console.warn.
  warn?: (msg: string) => void;
}

export function loadCoworkerConfig(
  coworkerDir: string,
  env: NodeJS.ProcessEnv,
  opts: LoadCoworkerConfigOptions = {},
): CoworkerConfig {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const schema = loadSchema();
  const path = join(coworkerDir, "config.json");

  let fileConfig: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    try {
      fileConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`config.json parse error at ${path}: ${(err as Error).message}`);
    }
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(fileConfig)) {
      const msg = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`)
        .join("; ");
      throw new Error(`config.json validation failed at ${path}: ${msg}`);
    }
  }

  const out = defaults();
  for (const key of Object.keys(ENV_MAP) as (keyof CoworkerConfig)[]) {
    const envName = ENV_MAP[key];
    const envRaw = env[envName];
    const inFile = key in fileConfig;

    if (inFile) {
      (out as Record<string, unknown>)[key] = fileConfig[key];
      if (envRaw !== undefined && !warnedKeys.has(`clash:${envName}`)) {
        warnedKeys.add(`clash:${envName}`);
        warn(`config: ${envName} set in env but overridden by config.json.${key}`);
      }
      continue;
    }
    if (envRaw !== undefined && envRaw !== "") {
      (out as Record<string, unknown>)[key] = coerceEnv(key, envRaw) as never;
      if (!warnedKeys.has(`dep:${envName}`)) {
        warnedKeys.add(`dep:${envName}`);
        warn(`env fallback for ${envName} — set in config.json instead (see AGENTS.md).`);
      }
    }
    // else: keep schema default
  }
  // work_hours has no env fallback and no default (absent = 24/7).
  if ("work_hours" in fileConfig) {
    const wh = fileConfig.work_hours as Partial<WorkHoursConfig> | undefined;
    if (wh) {
      // Enforce paired start/end (schema can't cross-validate this cheaply).
      const hasStart = typeof wh.start === "string";
      const hasEnd = typeof wh.end === "string";
      if (hasStart !== hasEnd) {
        throw new Error(
          `config.json validation failed at ${path}: /work_hours: 'start' and 'end' must be set together`,
        );
      }
      out.work_hours = {
        out_of_hours: (wh.out_of_hours as WorkHoursConfig["out_of_hours"]) ?? "normal",
        ...(wh.timezone !== undefined ? { timezone: wh.timezone } : {}),
        ...(wh.days !== undefined ? { days: wh.days } : {}),
        ...(wh.start !== undefined ? { start: wh.start } : {}),
        ...(wh.end !== undefined ? { end: wh.end } : {}),
        out_of_hours_interval_min: wh.out_of_hours_interval_min ?? 60,
      };
    }
  }
  return out;
}

// Test-only helper — clear the process-wide warning dedupe so a test that
// deliberately exercises the fallback path can observe the warning.
export function _resetWarnedKeysForTests(): void {
  warnedKeys.clear();
}
