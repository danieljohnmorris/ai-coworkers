// Declarative MCP sensors loaded from role/SENSORS.json instead of hard-coded
// in src/tools/*.ts. Same shape as native `kind: "sensor"` tools, but declared
// as JSON so a coworker can grow a new poll-and-diff feed by adding six lines
// of config rather than writing TypeScript.
//
// Schema (top-level is an array of specs):
//   [
//     {
//       "name": "github.review_requests",   // unique per coworker; also the
//                                            // key webhooks target via
//                                            // onEvent.invalidate.
//       "mcp": "github",                    // matches an MCP_SERVERS entry
//       "tool": "list_pulls",               // MCP tool name on that server
//       "args": { "state": "open" },        // optional; passed to the tool
//       "cacheMs": 60000,                   // optional; TTL for cached result
//       "summarise": "count"                // optional; shape reducer
//     }
//   ]
//
// summarise variants:
//   "identity"    — full result (default when omitted)
//   "count"       — find the first array in the result, return { count: n }
//   "first"       — first element of the first array found in the result
//   "data.path"   — dotted path into the result; returned subtree
//
// Missing file = empty specs, no errors. Bad JSON = one error entry, no specs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SensorSpec {
  name: string;
  mcp: string;
  tool: string;
  args?: Record<string, unknown>;
  cacheMs?: number;
  summarise?: string;
}

export interface LoadResult {
  specs: SensorSpec[];
  errors: string[];
  warnings: string[];
}

const BUILTIN_SUMMARISE = new Set(["identity", "count", "first"]);

// A summarise string is valid if it's one of the built-ins or looks like a
// dotted path (letters/digits/_ segments separated by '.'). Empty strings and
// leading/trailing dots are rejected.
export function isValidSummarise(s: string): boolean {
  if (BUILTIN_SUMMARISE.has(s)) return true;
  if (s.length === 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);
}

export function loadSensors(roleDir: string): LoadResult {
  const file = join(roleDir, "SENSORS.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(file)) return { specs: [], errors, warnings };

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (err) { return { specs: [], errors: [`SENSORS.json: bad JSON — ${err}`], warnings }; }

  if (!Array.isArray(raw)) {
    return { specs: [], errors: ["SENSORS.json: top-level must be an array"], warnings };
  }

  const specs: SensorSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const v = validateSpec(raw[i], i);
    if ("error" in v) { errors.push(v.error); continue; }
    if (seen.has(v.spec.name)) {
      errors.push(`spec[${i}]: duplicate sensor name "${v.spec.name}"`);
      continue;
    }
    seen.add(v.spec.name);
    specs.push(v.spec);
  }
  return { specs, errors, warnings };
}

function validateSpec(raw: unknown, i: number): { spec: SensorSpec } | { error: string } {
  const pfx = `spec[${i}]`;
  if (!raw || typeof raw !== "object") return { error: `${pfx}: not an object` };
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== "string" || r.name.length === 0) {
    return { error: `${pfx}: missing non-empty string 'name'` };
  }
  if (typeof r.mcp !== "string" || r.mcp.length === 0) {
    return { error: `${pfx} (${r.name}): missing non-empty string 'mcp'` };
  }
  if (typeof r.tool !== "string" || r.tool.length === 0) {
    return { error: `${pfx} (${r.name}): missing non-empty string 'tool'` };
  }
  if (r.args !== undefined && (typeof r.args !== "object" || r.args === null || Array.isArray(r.args))) {
    return { error: `${pfx} (${r.name}): 'args' must be an object if present` };
  }
  if (r.cacheMs !== undefined) {
    if (typeof r.cacheMs !== "number" || !Number.isInteger(r.cacheMs) || r.cacheMs < 0) {
      return { error: `${pfx} (${r.name}): 'cacheMs' must be a non-negative integer` };
    }
  }
  if (r.summarise !== undefined) {
    if (typeof r.summarise !== "string" || !isValidSummarise(r.summarise)) {
      return { error: `${pfx} (${r.name}): 'summarise' must be "identity" | "count" | "first" | dotted.path` };
    }
  }

  const spec: SensorSpec = {
    name: r.name,
    mcp: r.mcp,
    tool: r.tool,
    ...(r.args !== undefined ? { args: r.args as Record<string, unknown> } : {}),
    ...(r.cacheMs !== undefined ? { cacheMs: r.cacheMs as number } : {}),
    ...(r.summarise !== undefined ? { summarise: r.summarise as string } : {}),
  };
  return { spec };
}
