// Generic webhook router. Consumes WebhookSpec[] from webhooks_loader and
// dispatches inbound HTTP requests to the right verifier + filter + wake
// callback. Never triggers actions directly — only wakes the loop and hints
// which sensor caches to invalidate. All existing safety gates still apply.
//
// Response codes:
//   200 — signature ok, filter matched (if any), wake fired.
//   202 — signature ok, filter did not match; ack, no wake.
//   401 — bad or missing signature.
//   404 — no spec matched the request path.
//   503 — spec's secretEnv is not set in the process env.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runVerifier } from "./webhook_verifiers.ts";
import type { WebhookSpec } from "./webhooks_loader.ts";

export interface WebhookCallbacks {
  onWake: (reason: string) => void;
  invalidateSensor?: (name: string) => void;
}

export interface DispatchResult {
  status: number;
  body: { ok: boolean; reason?: string; name?: string };
}

export function dispatchWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  spec: WebhookSpec,
  cbs: WebhookCallbacks,
  env: Record<string, string | undefined>,
): DispatchResult {
  const secret = spec.auth.secretEnv ? env[spec.auth.secretEnv] : "";
  if (spec.auth.type !== "none" && !secret) {
    return { status: 503, body: { ok: false, reason: `env ${spec.auth.secretEnv} not set`, name: spec.name } };
  }
  const verdict = runVerifier(spec.auth.type, {
    ...(spec.auth.header ? { header: spec.auth.header } : {}),
    ...(spec.auth.maxAgeSeconds !== undefined ? { maxAgeSeconds: spec.auth.maxAgeSeconds } : {}),
  }, rawBody, headers, secret ?? "");
  if (!verdict.ok) return { status: 401, body: { ok: false, reason: verdict.reason, name: spec.name } };

  if (spec.filter) {
    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString("utf8")); }
    catch { return { status: 400, body: { ok: false, reason: "invalid JSON", name: spec.name } }; }
    const val = walkPath(payload, spec.filter.jsonPath);
    if (typeof val !== "string" || !spec.filter.allow.includes(val)) {
      return { status: 202, body: { ok: true, reason: "filter mismatch", name: spec.name } };
    }
  }

  if (spec.onEvent.invalidate && cbs.invalidateSensor) {
    for (const s of spec.onEvent.invalidate) cbs.invalidateSensor(s);
  }
  if (spec.onEvent.wake) cbs.onWake(`webhook:${spec.name}`);
  return { status: 200, body: { ok: true, reason: "waking", name: spec.name } };
}

function walkPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  specs: WebhookSpec[],
  cbs: WebhookCallbacks,
  env: Record<string, string | undefined>,
): Promise<void> {
  const url = (req.url ?? "").split("?")[0];
  const spec = specs.find((s) => s.path === url);
  if (!spec) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "no webhook spec for path" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const result = dispatchWebhook(body, req.headers, spec, cbs, env);
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
}
