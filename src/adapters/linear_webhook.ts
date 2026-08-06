// AIC-36 — Linear webhook adapter. When Linear fires an event we care
// about (issue created / updated / commented on a watched team), verify
// the HMAC signature and trigger a forceDeliberate tick. Cuts polling
// latency for teams that fire high-value events.
//
// Wired into the existing wake HTTP server: POST /linear-webhook alongside
// POST /wake. Reason it lives here and not in wake.ts: Linear-specific
// signature verification + team filtering shouldn't pollute the tiny
// generic wake path.
//
// Env:
//   LINEAR_WEBHOOK_SECRET     — HMAC secret configured in Linear's webhook
//                               settings. If unset, requests without a
//                               valid signature are REJECTED (fail-closed).
//   LINEAR_WATCHED_TEAMS      — comma-separated team keys (e.g. "ILO,AIC");
//                               events for other teams are 202-Accepted
//                               but do not wake. If unset, all teams wake.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface LinearWebhookOpts {
  secret: string;                      // required
  watchedTeams?: string[];             // undefined = accept all
  onWake: (reason: string) => void;    // called when a matching event lands
}

export interface DispatchResult {
  status: number;
  body: { ok: boolean; reason?: string; team?: string };
}

// Body handler — the caller reads the raw request body and passes it
// alongside the headers. Kept transport-agnostic so it's straightforward
// to unit-test without a real HTTP server.
export function dispatchLinearWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  opts: LinearWebhookOpts,
): DispatchResult {
  const sigHeader = headers["linear-signature"];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!sig || !opts.secret) return { status: 401, body: { ok: false, reason: "missing signature or secret" } };
  const expected = createHmac("sha256", opts.secret).update(rawBody).digest("hex");
  // timingSafeEqual requires equal-length buffers.
  if (sig.length !== expected.length) return { status: 401, body: { ok: false, reason: "bad signature length" } };
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (!timingSafeEqual(a, b)) return { status: 401, body: { ok: false, reason: "bad signature" } };

  // Signature is good — parse the payload.
  let payload: LinearWebhookPayload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { return { status: 400, body: { ok: false, reason: "invalid JSON" } }; }

  const teamKey = extractTeamKey(payload);
  if (opts.watchedTeams && opts.watchedTeams.length && teamKey && !opts.watchedTeams.includes(teamKey)) {
    return { status: 202, body: { ok: true, reason: "team not watched", team: teamKey } };
  }

  opts.onWake(`linear:${payload.action ?? "?"}:${teamKey ?? "unknown"}:${payload.type ?? "?"}`);
  return { status: 200, body: { ok: true, reason: "waking", team: teamKey ?? undefined } };
}

// Linear's webhook payload has a stable shape at the top level; the
// team key lives on the data object (varies by resource type).
interface LinearWebhookPayload {
  action?: string;             // "create" | "update" | "remove"
  type?: string;               // "Issue" | "Comment" | ...
  data?: {
    team?: { key?: string };
    teamKey?: string;
    issue?: { team?: { key?: string } };
  };
}

function extractTeamKey(p: LinearWebhookPayload): string | undefined {
  return p.data?.team?.key ?? p.data?.teamKey ?? p.data?.issue?.team?.key;
}

// Bundle helper for wiring into a bare Node http server — reads the body
// as a Buffer, then hands off to dispatchLinearWebhook. Lets wake.ts stay
// tiny.
export async function handleLinearWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: LinearWebhookOpts,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const result = dispatchLinearWebhook(body, req.headers, opts);
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
}
