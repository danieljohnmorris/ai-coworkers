// AIC-72 — tools for a coworker to log against per-branch rooms.
// Storage: coworkers/<name>/state/branches/<branch>.md
// See src/runtime/branch_room.ts for the on-disk shape.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { openBranchRoom, sanitizeBranch, type EntryKind } from "../runtime/branch_room.ts";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function roomFor(ctx: ToolCtx) {
  return openBranchRoom(join(REPO_ROOT, "coworkers", ctx.coworker, "state", "branches"));
}

const ENTRY_KINDS: EntryKind[] = ["patch", "ci", "review", "note", "merge", "close"];

export const branchNote: ToolDef = {
  name: "branch.note",
  kind: "action",
  description:
    "Append an entry to a branch's per-branch narrative file. Use this when you take an action on a branch, review a patch, notice CI results, or make a merge decision — the branch room becomes the record of why the code exists. Creates the room lazily on first append.",
  inputSchema: {
    type: "object",
    required: ["branch", "kind", "body"],
    properties: {
      branch: { type: "string", description: "Branch name, e.g. 'feat/parser-cleanup' or 'fix-aic-42'." },
      kind: { type: "string", enum: ENTRY_KINDS, description: "What kind of event this is." },
      body: { type: "string", description: "Plain markdown. Keep it short — one paragraph or a bullet list. Longer context belongs in a linked doc." },
      by: { type: "string", description: "Who wrote it. Defaults to your coworker name; use 'human'/'ci'/'github' when logging on behalf of another actor." },
    },
  },
  handler: async (
    input: { branch: string; kind: EntryKind; body: string; by?: string },
    ctx: ToolCtx,
  ) => {
    if (ctx.dryRun) return { dryRun: true, wouldAppend: { branch: input.branch, kind: input.kind, chars: input.body.length } };
    try { sanitizeBranch(input.branch); } catch (err) { return { error: String(err) }; }
    const room = roomFor(ctx);
    room.append(input.branch, { kind: input.kind, body: input.body, by: input.by ?? ctx.coworker });
    return { ok: true, path: room.path(input.branch) };
  },
};

export const branchRead: ToolDef = {
  name: "branch.read",
  kind: "action",
  description:
    "Read the full narrative for a branch — everything logged about it so far (patches, CI, review notes, merge decisions). Call this before acting on a branch you have touched before, so you build on prior context instead of re-litigating decisions.",
  inputSchema: {
    type: "object",
    required: ["branch"],
    properties: {
      branch: { type: "string", description: "Branch name." },
    },
  },
  handler: async (input: { branch: string }, ctx: ToolCtx) => {
    try { sanitizeBranch(input.branch); } catch (err) { return { error: String(err) }; }
    const room = roomFor(ctx);
    const text = room.read(input.branch);
    if (!text) return { branch: input.branch, empty: true };
    return { branch: input.branch, path: room.path(input.branch), body: text };
  },
};

export const branchList: ToolDef = {
  name: "branch.list",
  kind: "sensor",
  description:
    "List active branch rooms (branches you or someone else has logged notes against). Sorted newest-updated first. Use to see what work is in-flight and whether a branch already has a running record before opening a new one.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx: ToolCtx) => {
    const room = roomFor(ctx);
    return { branches: room.list() };
  },
};

export const branchRoomTools: ToolDef[] = [branchNote, branchRead, branchList];
