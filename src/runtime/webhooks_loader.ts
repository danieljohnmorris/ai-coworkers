// Declarative webhooks — each coworker declares its inbound webhooks in
// coworkers/<name>/role/WEBHOOKS.json. Adding a new integration is a config
// edit, not code. Verification schemes are a closed set — see
// webhook_verifiers.ts. Missing file is fine (returns []).
//
// Schema (single JSON file, array of specs):
//   [
//     {
//       "name": "linear",
//       "path": "/webhook/linear",
//       "auth": {
//         "type": "hmac-sha256",       // closed set
//         "header": "linear-signature",
//         "secretEnv": "LINEAR_WEBHOOK_SECRET",
//         "maxAgeSeconds": 300           // slack-v0 only
//       },
//       "filter": { "jsonPath": "data.team.key", "allow": ["ILO", "AIC"] },
//       "onEvent": { "wake": true, "invalidate": ["linear.new_issues"] }
//     }
//   ]

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifierKind } from "./webhook_verifiers.ts";

export interface WebhookSpec {
  name: string;
  path: string;
  auth: {
    type: VerifierKind;
    header?: string;
    secretEnv?: string;
    maxAgeSeconds?: number;
  };
  filter?: { jsonPath: string; allow: string[] };
  onEvent: {
    wake: boolean;
    invalidate?: string[];
  };
}

export interface LoadResult {
  specs: WebhookSpec[];
  errors: string[];
  warnings: string[];
}

const VALID_TYPES: readonly VerifierKind[] = ["hmac-sha256", "github-sha256", "slack-v0", "none"];

export function loadWebhooks(roleDir: string): LoadResult {
  const file = join(roleDir, "WEBHOOKS.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(file)) return { specs: [], errors, warnings };

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (err) { return { specs: [], errors: [`WEBHOOKS.json: bad JSON — ${err}`], warnings }; }

  if (!Array.isArray(raw)) return { specs: [], errors: ["WEBHOOKS.json: top-level must be an array"], warnings };

  const specs: WebhookSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const v = validateSpec(item, i);
    if ("error" in v) { errors.push(v.error); continue; }
    if (seen.has(v.spec.name)) { errors.push(`spec[${i}]: duplicate webhook name "${v.spec.name}"`); continue; }
    seen.add(v.spec.name);
    if (v.spec.auth.type === "none") warnings.push(`webhook "${v.spec.name}" uses auth.type "none" — signature checks are DISABLED`);
    specs.push(v.spec);
  }
  return { specs, errors, warnings };
}

function validateSpec(raw: unknown, i: number): { spec: WebhookSpec } | { error: string } {
  const pfx = `spec[${i}]`;
  if (!raw || typeof raw !== "object") return { error: `${pfx}: not an object` };
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) return { error: `${pfx}: missing string 'name'` };
  if (typeof r.path !== "string" || !r.path.startsWith("/webhook/")) return { error: `${pfx}: path must start with /webhook/` };
  if (!r.auth || typeof r.auth !== "object") return { error: `${pfx}: missing object 'auth'` };
  const auth = r.auth as Record<string, unknown>;
  if (typeof auth.type !== "string" || !(VALID_TYPES as readonly string[]).includes(auth.type)) {
    return { error: `${pfx}: auth.type must be one of ${VALID_TYPES.join(", ")}` };
  }
  if (auth.type === "hmac-sha256" && (typeof auth.header !== "string" || !auth.header)) {
    return { error: `${pfx}: auth.type=hmac-sha256 requires 'header'` };
  }
  if (auth.type !== "none" && (typeof auth.secretEnv !== "string" || !auth.secretEnv)) {
    return { error: `${pfx}: auth.secretEnv required for auth.type=${auth.type}` };
  }
  if (auth.maxAgeSeconds !== undefined && (typeof auth.maxAgeSeconds !== "number" || auth.maxAgeSeconds <= 0)) {
    return { error: `${pfx}: auth.maxAgeSeconds must be a positive number` };
  }
  let filter: WebhookSpec["filter"];
  if (r.filter !== undefined) {
    if (!r.filter || typeof r.filter !== "object") return { error: `${pfx}: filter must be an object` };
    const f = r.filter as Record<string, unknown>;
    if (typeof f.jsonPath !== "string" || !f.jsonPath) return { error: `${pfx}: filter.jsonPath required` };
    if (!Array.isArray(f.allow) || !f.allow.every((x) => typeof x === "string")) {
      return { error: `${pfx}: filter.allow must be a string[]` };
    }
    filter = { jsonPath: f.jsonPath, allow: f.allow as string[] };
  }
  if (!r.onEvent || typeof r.onEvent !== "object") return { error: `${pfx}: missing object 'onEvent'` };
  const onEvent = r.onEvent as Record<string, unknown>;
  const wake = typeof onEvent.wake === "boolean" ? onEvent.wake : true;
  let invalidate: string[] | undefined;
  if (onEvent.invalidate !== undefined) {
    if (!Array.isArray(onEvent.invalidate) || !onEvent.invalidate.every((x) => typeof x === "string")) {
      return { error: `${pfx}: onEvent.invalidate must be a string[]` };
    }
    invalidate = onEvent.invalidate as string[];
  }

  const spec: WebhookSpec = {
    name: r.name,
    path: r.path,
    auth: {
      type: auth.type as VerifierKind,
      ...(typeof auth.header === "string" ? { header: auth.header } : {}),
      ...(typeof auth.secretEnv === "string" ? { secretEnv: auth.secretEnv } : {}),
      ...(typeof auth.maxAgeSeconds === "number" ? { maxAgeSeconds: auth.maxAgeSeconds } : {}),
    },
    ...(filter ? { filter } : {}),
    onEvent: { wake, ...(invalidate ? { invalidate } : {}) },
  };
  return { spec };
}
