// Gmail (and eventually the wider Google Workspace) tool. Shells out to
// Hermes's google_api.py CLI, scoped to this coworker's own token via
// HERMES_HOME=coworkers/<name>/state/hermes-home. Setup happens once per
// coworker via bin/setup-gmail.sh; this file only makes the API calls.
//
// Why shell out instead of using the Google API client directly:
//   - Reuses Hermes's already-battle-tested Python client + `gws` fallback.
//   - No new deps in our Node project.
//   - Token refresh, retry, quota-aware backoff — all handled by Hermes.
//   - Same setup UX operators already know from Hermes.
//
// Requires:
//   - Hermes google-workspace skill installed at ~/.hermes/skills/productivity/google-workspace
//   - python3 on PATH
//   - `bin/setup-gmail.sh <coworker>` run at least once
//
// Fails soft: if Hermes isn't installed or setup hasn't run, tools return
// `{ warning: "gmail not configured — run bin/setup-gmail.sh <coworker>" }`
// instead of throwing. Coworkers just skip these tools on that tick.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SKILL_DIR = `${process.env.HOME}/.hermes/skills/productivity/google-workspace/scripts`;

function hermesHomeFor(coworker: string): string {
  return join(REPO_ROOT, "coworkers", coworker, "state", "hermes-home");
}

function skillInstalled(): boolean {
  return existsSync(`${SKILL_DIR}/google_api.py`);
}

function tokenReady(coworker: string): boolean {
  return existsSync(join(hermesHomeFor(coworker), "google_token.json"));
}

// Run google_api.py with the coworker's scoped HERMES_HOME. Returns
// { ok, stdout, stderr, code }. Never throws.
async function runGoogleApi(coworker: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [`${SKILL_DIR}/google_api.py`, ...args], {
      env: { ...process.env, HERMES_HOME: hermesHomeFor(coworker) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* noop */ } }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ ok: false, stdout: "", stderr: String(err), code: null });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        code,
      });
    });
  });
}

function notReady(coworker: string): { warning: string } | null {
  if (!skillInstalled()) return { warning: `Hermes google-workspace skill not installed at ${SKILL_DIR} — install Hermes first.` };
  if (!tokenReady(coworker)) return { warning: `Gmail not configured for '${coworker}' — run bin/setup-gmail.sh ${coworker}` };
  return null;
}

export const gmailSearch: ToolDef = {
  name: "gmail.search",
  kind: "sensor",
  description: "Search Gmail. Query uses Gmail search syntax: is:unread from:x@y.com newer_than:1d subject:\"parser\" etc. Returns a compact list of message IDs + subjects + snippets.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Gmail search query (see https://support.google.com/mail/answer/7190)" },
      max:   { type: "number", description: "Max results (default 10, cap 50)" },
    },
  },
  handler: async (input: { query: string; max?: number }, ctx: ToolCtx) => {
    const ready = notReady(ctx.coworker);
    if (ready) return ready;
    const max = Math.min(input.max ?? 10, 50);
    const r = await runGoogleApi(ctx.coworker, ["gmail", "search", input.query, "--max", String(max)]);
    if (!r.ok) return { error: `gmail.search failed (exit ${r.code}): ${r.stderr.slice(0, 400)}` };
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
  },
};

export const gmailGet: ToolDef = {
  name: "gmail.get",
  kind: "action",
  description: "Fetch a full Gmail message by ID (from gmail.search results). Read-only.",
  inputSchema: {
    type: "object",
    required: ["messageId"],
    properties: { messageId: { type: "string" } },
  },
  handler: async (input: { messageId: string }, ctx: ToolCtx) => {
    const ready = notReady(ctx.coworker);
    if (ready) return ready;
    const r = await runGoogleApi(ctx.coworker, ["gmail", "get", input.messageId]);
    if (!r.ok) return { error: `gmail.get failed (exit ${r.code}): ${r.stderr.slice(0, 400)}` };
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
  },
};

export const gmailSend: ToolDef = {
  name: "gmail.send",
  kind: "action",
  description: "Send a new Gmail message. Honors dry-run.",
  inputSchema: {
    type: "object",
    required: ["to", "subject", "body"],
    properties: {
      to:      { type: "string", description: "Recipient email (or comma-separated list)" },
      subject: { type: "string" },
      body:    { type: "string", description: "Plain text body" },
    },
  },
  handler: async (input: { to: string; subject: string; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: { to: input.to, subject: input.subject, bodyChars: input.body.length } };
    const ready = notReady(ctx.coworker);
    if (ready) return ready;
    const r = await runGoogleApi(ctx.coworker, [
      "gmail", "send", "--to", input.to, "--subject", input.subject, "--body", input.body,
    ]);
    if (!r.ok) return { error: `gmail.send failed (exit ${r.code}): ${r.stderr.slice(0, 400)}` };
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
  },
};

export const gmailReply: ToolDef = {
  name: "gmail.reply",
  kind: "action",
  description: "Reply to a Gmail message (keeps the thread). Honors dry-run.",
  inputSchema: {
    type: "object",
    required: ["messageId", "body"],
    properties: {
      messageId: { type: "string" },
      body:      { type: "string" },
    },
  },
  handler: async (input: { messageId: string; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: { messageId: input.messageId, bodyChars: input.body.length } };
    const ready = notReady(ctx.coworker);
    if (ready) return ready;
    const r = await runGoogleApi(ctx.coworker, ["gmail", "reply", input.messageId, "--body", input.body]);
    if (!r.ok) return { error: `gmail.reply failed (exit ${r.code}): ${r.stderr.slice(0, 400)}` };
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
  },
};

export const gmailTools: ToolDef[] = [gmailSearch, gmailGet, gmailSend, gmailReply];
