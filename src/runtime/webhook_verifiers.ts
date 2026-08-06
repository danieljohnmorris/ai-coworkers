// Closed set of webhook signature verifiers. Adding a new scheme is a PR to
// this file, not a runtime plugin — keeps the crypto surface small and
// auditable. All verifiers use constant-time compare and guard equal-length
// before compare.
//
// Kinds:
//   hmac-sha256   — HMAC-SHA256(body), hex-compare against a caller-named
//                   header (opts.header required).
//   github-sha256 — same, but strips "sha256=" prefix; default header
//                   x-hub-signature-256.
//   slack-v0      — Slack's v0 scheme: HMAC-SHA256(`v0:{ts}:{body}`), hex
//                   compare against `v0={hex}` in x-slack-signature. Also
//                   enforces |now - x-slack-request-timestamp| ≤ maxAgeSeconds
//                   (default 300s).
//   none          — always ok. Loader emits a startup warning.

import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifierKind = "hmac-sha256" | "github-sha256" | "slack-v0" | "none";

export interface VerifierOpts {
  header?: string;
  maxAgeSeconds?: number;
}

export interface VerifyResult { ok: boolean; reason?: string }

type Headers = Record<string, string | string[] | undefined>;

function header(h: Headers, name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function eqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function verifyHmacSha256(rawBody: Buffer, headers: Headers, secret: string, opts: VerifierOpts): VerifyResult {
  if (!opts.header) return { ok: false, reason: "missing header name" };
  const sig = header(headers, opts.header);
  if (!sig) return { ok: false, reason: "missing signature header" };
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!eqHex(sig, expected)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

export function verifyGithubSha256(rawBody: Buffer, headers: Headers, secret: string, opts: VerifierOpts): VerifyResult {
  const name = opts.header ?? "x-hub-signature-256";
  const raw = header(headers, name);
  if (!raw) return { ok: false, reason: "missing signature header" };
  const sig = raw.startsWith("sha256=") ? raw.slice("sha256=".length) : raw;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!eqHex(sig, expected)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

export function verifySlackV0(rawBody: Buffer, headers: Headers, secret: string, opts: VerifierOpts, nowMs = Date.now()): VerifyResult {
  const sig = header(headers, "x-slack-signature");
  const ts = header(headers, "x-slack-request-timestamp");
  if (!sig) return { ok: false, reason: "missing x-slack-signature" };
  if (!ts) return { ok: false, reason: "missing x-slack-request-timestamp" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad timestamp" };
  const maxAge = opts.maxAgeSeconds ?? 300;
  if (Math.abs(Math.floor(nowMs / 1000) - tsNum) > maxAge) return { ok: false, reason: "stale timestamp" };
  const basestring = `v0:${ts}:${rawBody.toString("utf8")}`;
  const expected = "v0=" + createHmac("sha256", secret).update(basestring).digest("hex");
  if (!eqHex(sig, expected)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

export function runVerifier(
  kind: VerifierKind,
  opts: VerifierOpts,
  rawBody: Buffer,
  headers: Headers,
  secret: string,
  nowMs?: number,
): VerifyResult {
  switch (kind) {
    case "hmac-sha256":   return verifyHmacSha256(rawBody, headers, secret, opts);
    case "github-sha256": return verifyGithubSha256(rawBody, headers, secret, opts);
    case "slack-v0":      return verifySlackV0(rawBody, headers, secret, opts, nowMs);
    case "none":          return { ok: true };
  }
}
