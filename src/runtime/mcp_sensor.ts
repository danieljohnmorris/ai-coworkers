// Runtime for declarative MCP sensors (see sensors_loader.ts for the config
// surface). Given a set of specs and a map of MCP clients keyed by server
// name, McpSensorRunner turns each tick's sense phase into:
//   1. cache hit within TTL? → reuse.
//   2. else call mcp.callTool(spec.tool, spec.args), summarise, cache.
//   3. errors are captured on the result (not thrown), matching how native
//      sensors surface failures in Perception.sensors[].
//
// invalidate(name) drops the cache for one sensor AND forces the next tick's
// diff to report changedSinceLast=true for it even if the value happens to
// match the last observation — a webhook that says "this changed" is stronger
// evidence than a JSON-equal poll result.

import type { SensorSpec } from "./sensors_loader.ts";

export interface McpClientLike {
  callTool: (name: string, args?: unknown) => Promise<unknown>;
}

export interface SensorResult {
  name: string;
  result: unknown;
  error?: string;
  changedSinceLast: boolean;
}

export interface McpSensorRunnerOpts {
  specs: SensorSpec[];
  mcpClients: Map<string, McpClientLike>;
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  error?: string;
  at: number;
}

export class McpSensorRunner {
  private readonly specs: SensorSpec[];
  private readonly clients: Map<string, McpClientLike>;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly last = new Map<string, string>();  // JSON of last emitted result
  private readonly forcedChange = new Set<string>();

  constructor(opts: McpSensorRunnerOpts) {
    this.specs = opts.specs;
    this.clients = opts.mcpClients;
    this.now = opts.now ?? Date.now;
  }

  invalidate(sensorName: string): void {
    this.cache.delete(sensorName);
    this.forcedChange.add(sensorName);
  }

  async runOnce(): Promise<SensorResult[]> {
    const out: SensorResult[] = [];
    for (const spec of this.specs) {
      out.push(await this.runOne(spec));
    }
    return out;
  }

  private async runOne(spec: SensorSpec): Promise<SensorResult> {
    const now = this.now();
    const ttl = spec.cacheMs ?? 0;
    const cached = this.cache.get(spec.name);
    let value: unknown;
    let error: string | undefined;

    if (cached !== undefined && ttl > 0 && (now - cached.at) < ttl) {
      value = cached.value;
      error = cached.error;
    } else {
      const client = this.clients.get(spec.mcp);
      if (!client) {
        error = `no MCP client registered for server "${spec.mcp}"`;
        value = null;
      } else {
        try {
          const raw = await client.callTool(spec.tool, spec.args);
          value = summarise(raw, spec.summarise);
        } catch (err) {
          error = String(err);
          value = null;
        }
      }
      if (ttl > 0) this.cache.set(spec.name, { value, ...(error ? { error } : {}), at: now });
    }

    // Diff: JSON-stable compare against last emitted (both value and error
    // participate — an ok→error transition is a change).
    const signature = stableStringify({ v: value, e: error ?? null });
    const prev = this.last.get(spec.name);
    let changed = prev === undefined ? true : prev !== signature;
    if (this.forcedChange.has(spec.name)) {
      changed = true;
      this.forcedChange.delete(spec.name);
    }
    this.last.set(spec.name, signature);

    return {
      name: spec.name,
      result: value,
      ...(error ? { error } : {}),
      changedSinceLast: changed,
    };
  }
}

// Apply a summarise directive. Unknown/absent → identity. Invalid path returns
// undefined (matches "walked off the tree"). Kept small and pure for testing.
export function summarise(raw: unknown, mode: string | undefined): unknown {
  if (!mode || mode === "identity") return raw;
  if (mode === "count") {
    const arr = findFirstArray(raw);
    return { count: arr ? arr.length : 0 };
  }
  if (mode === "first") {
    const arr = findFirstArray(raw);
    return arr && arr.length > 0 ? arr[0] : null;
  }
  // dotted path
  return walkPath(raw, mode);
}

function findFirstArray(x: unknown): unknown[] | null {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== "object") return null;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

function walkPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// Stable JSON: sorts object keys so { a: 1, b: 2 } and { b: 2, a: 1 } compare
// equal. Arrays keep their order — order-in is order-out is the natural
// semantic for a poll result.
export function stableStringify(x: unknown): string {
  return JSON.stringify(canonicalise(x));
}

function canonicalise(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(canonicalise);
  const keys = Object.keys(x as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canonicalise((x as Record<string, unknown>)[k]);
  return out;
}
