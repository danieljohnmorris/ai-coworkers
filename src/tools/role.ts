// Role tools — let the coworker propose (never apply) changes to its own
// role/ docs. The proposal lands in state/proposals/ for a human to review
// with bin/review-proposal.sh. See runtime/role-proposals.ts for the guards.
//
// Filing a proposal also notifies the manager so it doesn't sit undiscovered:
// via Slack if MANAGER_SLACK is set (e.g. "@U0123ABC" or "#coworker-ops"),
// otherwise via the persistent questions.md channel (same as ask→manager).

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { proposeRoleChange, pendingProposals, PROPOSABLE_DOCS } from "../runtime/role-proposals.ts";
import { ask } from "./ask.ts";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function dirs(ctx: ToolCtx): { proposalsDir: string; roleDir: string } {
  const base = join(REPO_ROOT, "coworkers", ctx.coworker);
  return { proposalsDir: join(base, "state", "proposals"), roleDir: join(base, "role") };
}

export const roleProposeChange: ToolDef = {
  name: "role.propose_change",
  kind: "action",
  description:
    "Propose a change to one of your own role documents (ROLE, RESPONSIBILITIES, AUTHORITY, BOUNDARIES, RITUALS, RELATIONSHIPS, TOOLS). You cannot edit these directly — this files a proposal for your manager to accept or reject. Use it when you repeatedly hit a limit that blocks useful work (e.g. an authority you keep needing, a boundary that is miscalibrated, a ritual worth adding). Provide the FULL replacement body for the doc, not a diff. Propose sparingly: one pending proposal per doc, and frivolous proposals erode trust.",
  inputSchema: {
    type: "object",
    required: ["doc", "body", "rationale"],
    properties: {
      doc: {
        type: "string",
        enum: [...PROPOSABLE_DOCS],
        description: "Which role doc to change.",
      },
      body: {
        type: "string",
        description: "Full proposed replacement body for the doc, plain markdown. Keep everything that should stay; this replaces the whole file if accepted.",
      },
      rationale: {
        type: "string",
        description: "Why this change helps — cite the concrete situations (tickets, blocks, repeated asks) that motivated it.",
      },
    },
  },
  handler: async (input: { doc: string; body: string; rationale: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: { doc: input.doc, rationale: input.rationale } };
    const { proposalsDir, roleDir } = dirs(ctx);
    const r = proposeRoleChange({ proposalsDir, roleDir, doc: input.doc, body: input.body, rationale: input.rationale });
    if (!r.accepted) return r;

    // Push the review request to the manager instead of waiting to be found.
    const managerSlack = ctx.env.MANAGER_SLACK?.trim();
    const to = managerSlack ? `slack:${managerSlack}` : "manager";
    const question = `I've proposed a change to my ${input.doc}.md (${r.id}). Rationale: ${input.rationale.slice(0, 300)}`;
    const context = `review with: bin/review-proposal.sh ${ctx.coworker} show ${r.id}`;
    let notified: unknown;
    try {
      notified = await ask.handler({ to, question, context }, ctx);
    } catch (err) {
      // Slack down ≠ proposal lost — fall back to the persistent question log.
      try {
        notified = await ask.handler({ to: "manager", question, context }, ctx);
      } catch (err2) {
        notified = { error: String(err2) };
      }
    }
    return { ...r, notified };
  },
};

export const rolePendingProposals: ToolDef = {
  name: "role.pending_proposals",
  kind: "action",
  description:
    "List your own role-change proposals that are still awaiting human review. Check this before filing a new proposal for the same doc.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input: unknown, ctx: ToolCtx) => {
    const { proposalsDir } = dirs(ctx);
    const pending = pendingProposals(proposalsDir).map((p) => ({
      id: p.id, doc: p.doc, ts: p.ts, rationale: p.rationale,
    }));
    return { count: pending.length, pending };
  },
};

export const roleTools: ToolDef[] = [roleProposeChange, rolePendingProposals];
