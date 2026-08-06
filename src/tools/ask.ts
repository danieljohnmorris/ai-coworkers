// Ask a question of the human manager, a peer coworker, or anyone reachable
// via Slack. Chooses the transport based on the "to" field:
//
//   to = "manager"                → logs to state/questions.md, human answers
//                                   via bin/answer.sh or by editing the file
//   to = "coworker:<name>"        → writes to that coworker's inbox.md — a
//                                   peer message they'll see next tick
//   to = "slack:@user"            → DMs a Slack user (needs SLACK_BOT_TOKEN)
//   to = "slack:#channel"         → posts to a Slack channel
//
// Unanswered questions to the human persist in questions.md and are surfaced
// in every deliberation so the coworker doesn't forget it asked.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { slackPost, slackDM } from "./slack.ts";
import { linearComment } from "./linear.ts";
import { githubPRComment } from "./github.ts";
import { redact, knownSecretsFrom } from "../runtime/secret_redaction.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function questionsPath(coworker: string): string {
  return join(REPO_ROOT, "coworkers", coworker, "state", "questions.md");
}
function inboxPath(coworker: string): string {
  return join(REPO_ROOT, "coworkers", coworker, "state", "inbox.md");
}

export const ask: ToolDef = {
  name: "ask",
  // ask routes to slack / linear / github, so it needs any credential the
  // underlying tools might reach for.
  requiresCreds: ["SLACK_BOT_TOKEN", "LINEAR_API_KEY", "GITHUB_TOKEN"],
  kind: "action",
  description:
    "Ask a question of your manager, a peer coworker, or anyone via Slack. Use when you genuinely need input to proceed. Do NOT use for routine work. The question persists (or is delivered) — you will see any unanswered questions to your manager in future perception until resolved, so ask only when blocked.",
  inputSchema: {
    type: "object",
    required: ["to", "question"],
    properties: {
      to: {
        type: "string",
        description:
          'Recipient. One of: "manager" (persistent human question log), "coworker:<name>" (peer coworker inbox), "slack:@userId" (DM), "slack:#channel" (channel), "linear:ISSUE-ID" (comment on ticket), "github:owner/repo#123" (comment on PR). Choose the channel the person originally contacted you on wherever possible — reply in the same thread they started. Reserve "manager" for genuinely blocking questions; reserve email/urgent DMs for time-sensitive things.',
      },
      question: { type: "string", description: "One-paragraph question. Terse and specific." },
      context: { type: "string", description: "Optional: ticket ID, URL, or quote of what triggered it." },
    },
  },
  handler: async (input: { to: string; question: string; context?: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: input };

    // Secret-scan every outbound piece BEFORE assembly. If any part looks
    // like it contains a credential (either a pattern match or a literal
    // env-derived secret), we redact and return a `redacted: true` flag so
    // the coworker knows and can decide whether to try a different phrasing.
    // Absolute refusal isn't right here — a legitimate error message might
    // trip the pattern list (unlikely but possible); silent redaction gives
    // us defence in depth without false-blocking real work.
    const known = knownSecretsFrom(ctx.env);
    const q = redact(input.question, known);
    const c = input.context ? redact(input.context, known) : { text: "", redactionCount: 0 };
    const redactionCount = q.redactionCount + c.redactionCount;
    const question = q.text;
    const context = c.text;
    const body = context ? `${question}\n\n(context: ${context})` : question;
    const redactionMeta = redactionCount > 0 ? { redacted: true, redactionCount } : {};

    // --- manager (default human) — persistent question log ---
    if (input.to === "manager") {
      const path = questionsPath(ctx.coworker);
      mkdirSync(dirname(path), { recursive: true });
      const block = [
        `## ${new Date().toISOString()}`,
        `**Q:** ${question}`,
        context ? `**Context:** ${context}` : "",
        `**A:** _(unanswered)_`,
        ``,
      ].filter(Boolean).join("\n") + "\n";
      appendFileSync(path, block);
      return { delivered: "manager", path, ...redactionMeta };
    }

    // --- peer coworker — writes to their inbox ---
    if (input.to.startsWith("coworker:")) {
      const peer = input.to.slice("coworker:".length);
      const path = inboxPath(peer);
      if (!existsSync(dirname(path))) return { error: `no coworker named ${peer}` };
      const entry = `## ${new Date().toISOString()} — from ${ctx.coworker}\n${body}\n\n`;
      appendFileSync(path, entry);
      return { delivered: `coworker:${peer}`, path, ...redactionMeta };
    }

    // --- slack DM or channel ---
    if (input.to.startsWith("slack:")) {
      const target = input.to.slice("slack:".length);
      const framed = `${body}\n\n_— asked by ${ctx.coworker}_`;
      const result = target.startsWith("@")
        ? await slackDM.handler({ user: target.slice(1), text: framed }, ctx)
        : await slackPost.handler({ channel: target, text: framed }, ctx);
      return { ...(result as object), ...redactionMeta };
    }

    // --- linear ticket comment (reply where the ticket lives) ---
    if (input.to.startsWith("linear:")) {
      const issueId = input.to.slice("linear:".length);
      const result = await linearComment.handler({ issueId, body }, ctx);
      return { ...(result as object), ...redactionMeta };
    }

    // --- github PR comment ---
    if (input.to.startsWith("github:")) {
      const spec = input.to.slice("github:".length);          // owner/repo#123
      const [repo, numStr] = spec.split("#");
      const number = Number(numStr);
      if (!repo || !Number.isFinite(number)) return { error: `bad github spec: ${input.to}` };
      const result = await githubPRComment.handler({ repo, number, body }, ctx);
      return { ...(result as object), ...redactionMeta };
    }

    return { error: `unknown recipient shape: ${input.to}` };
  },
};

export function unansweredQuestions(coworker: string): string {
  const path = questionsPath(coworker);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const blocks = text.split(/^## /m).filter(Boolean);
  const unanswered = blocks
    .map((b) => "## " + b.trim())
    .filter((b) => /\*\*A:\*\*\s*_?\(?unanswered\)?_?/i.test(b));
  return unanswered.join("\n\n");
}

export const askTools: ToolDef[] = [ask];
