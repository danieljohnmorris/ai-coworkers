// Role-change proposals — the coworker's channel for suggesting edits to its
// own role/ docs (ROLE.md, AUTHORITY.md, BOUNDARIES.md, …) WITHOUT the power
// to apply them. The role folder stays human-write-only; the coworker files a
// proposal and a human accepts or rejects it via bin/review-proposal.sh.
//
// Layout:
//   coworkers/<name>/state/proposals/<id>.md    one file per proposal
//
// Each proposal records the target doc, a rationale, the full proposed body,
// and a hash of the doc as the coworker saw it. Accepting applies the body to
// role/<DOC>.md only if the doc is unchanged since the proposal was filed
// (stale guard) — otherwise the human is told to re-review.
//
// Same trust posture as semantic memory: proposed text is injection-scanned
// and size-capped before it's persisted anywhere.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scan } from "./injection.ts";

// Docs the coworker may propose changes to. Deliberately excludes WORKSPACE
// (human-authored world context — the coworker has no standing to rewrite it).
export const PROPOSABLE_DOCS = [
  "ROLE",
  "RESPONSIBILITIES",
  "AUTHORITY",
  "BOUNDARIES",
  "RITUALS",
  "RELATIONSHIPS",
  "TOOLS",
] as const;
export type ProposableDoc = (typeof PROPOSABLE_DOCS)[number];

const BODY_CAP = 8192;        // proposed doc body
const RATIONALE_CAP = 1024;

export interface Proposal {
  id: string;
  doc: ProposableDoc;
  status: "pending" | "accepted" | "rejected" | "stale";
  ts: string;
  rationale: string;
  baseHash: string;            // sha1 of role/<DOC>.md when proposal was filed
  body: string;                // full proposed replacement body
  resolution?: string;         // human note on accept/reject
}

export interface ProposeResult {
  accepted: boolean;
  reason: string;
  id?: string;
  path?: string;
  suspicious?: boolean;
  hits?: string[];
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function docPath(roleDir: string, doc: ProposableDoc): string {
  return join(roleDir, `${doc}.md`);
}

function readDoc(roleDir: string, doc: ProposableDoc): string {
  const p = docPath(roleDir, doc);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// --- filing (coworker side) ---

export function proposeRoleChange(args: {
  proposalsDir: string;        // coworkers/<name>/state/proposals
  roleDir: string;             // coworkers/<name>/role
  doc: string;
  body: string;                // full proposed replacement for the doc
  rationale: string;
  now?: Date;
}): ProposeResult {
  const doc = args.doc.toUpperCase().replace(/\.md$/i, "");
  if (!(PROPOSABLE_DOCS as readonly string[]).includes(doc)) {
    return { accepted: false, reason: `doc must be one of: ${PROPOSABLE_DOCS.join(", ")}` };
  }
  const body = args.body.trim();
  const rationale = args.rationale.trim();
  if (!body) return { accepted: false, reason: "empty proposed body" };
  if (!rationale) return { accepted: false, reason: "a rationale is required — say why the change helps" };
  if (body.length > BODY_CAP) return { accepted: false, reason: `proposed body over ${BODY_CAP} char cap` };
  if (rationale.length > RATIONALE_CAP) return { accepted: false, reason: `rationale over ${RATIONALE_CAP} char cap` };

  const s = scan(body + "\n" + rationale);
  if (s.suspicious) {
    return { accepted: false, reason: "flagged by injection scanner", suspicious: true, hits: s.hits };
  }

  // One pending proposal per doc — forces the coworker to wait for a verdict
  // instead of piling up variants.
  const existing = listProposals(args.proposalsDir).find(
    (p) => p.doc === doc && p.status === "pending"
  );
  if (existing) {
    return { accepted: false, reason: `a pending proposal for ${doc} already exists (${existing.id}) — wait for review` };
  }

  const current = readDoc(args.roleDir, doc as ProposableDoc);
  if (body === current.trim()) {
    return { accepted: false, reason: "proposed body is identical to the current doc" };
  }

  const now = args.now ?? new Date();
  const id = `${now.toISOString().slice(0, 10)}-${doc.toLowerCase()}-${hashOf(body).slice(0, 6)}`;
  const proposal: Proposal = {
    id,
    doc: doc as ProposableDoc,
    status: "pending",
    ts: now.toISOString(),
    rationale,
    baseHash: hashOf(current),
    body,
  };
  mkdirSync(args.proposalsDir, { recursive: true });
  const path = join(args.proposalsDir, `${id}.md`);
  writeFileSync(path, renderProposal(proposal));
  return { accepted: true, reason: "filed for human review", id, path };
}

// --- listing ---

export function listProposals(proposalsDir: string): Proposal[] {
  if (!existsSync(proposalsDir)) return [];
  return readdirSync(proposalsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseProposal(readFileSync(join(proposalsDir, f), "utf8")))
    .filter((p): p is Proposal => p !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

export function pendingProposals(proposalsDir: string): Proposal[] {
  return listProposals(proposalsDir).filter((p) => p.status === "pending");
}

// --- resolving (human side, via bin/review-proposal.sh) ---

export function resolveProposal(args: {
  proposalsDir: string;
  roleDir: string;
  id: string;
  verdict: "accept" | "reject";
  note?: string;
}): { ok: boolean; reason: string; applied?: boolean } {
  const path = join(args.proposalsDir, `${args.id}.md`);
  if (!existsSync(path)) return { ok: false, reason: `no proposal ${args.id}` };
  const p = parseProposal(readFileSync(path, "utf8"));
  if (!p) return { ok: false, reason: `could not parse proposal ${args.id}` };
  if (p.status !== "pending") return { ok: false, reason: `proposal is ${p.status}, not pending` };

  if (args.verdict === "reject") {
    p.status = "rejected";
    p.resolution = args.note ?? "";
    writeFileSync(path, renderProposal(p));
    return { ok: true, reason: "rejected", applied: false };
  }

  // Accept — stale guard first: the doc must be unchanged since filing.
  const current = readDoc(args.roleDir, p.doc);
  if (hashOf(current) !== p.baseHash) {
    p.status = "stale";
    p.resolution = "role doc changed since proposal was filed — re-review needed";
    writeFileSync(path, renderProposal(p));
    return { ok: false, reason: "stale: role doc changed since proposal was filed", applied: false };
  }
  writeFileSync(docPath(args.roleDir, p.doc), p.body + "\n");
  p.status = "accepted";
  p.resolution = args.note ?? "";
  writeFileSync(path, renderProposal(p));
  return { ok: true, reason: "accepted and applied", applied: true };
}

// --- serialization: markdown with a small front-matter block ---

function renderProposal(p: Proposal): string {
  const fm = [
    "---",
    `id: ${p.id}`,
    `doc: ${p.doc}`,
    `status: ${p.status}`,
    `ts: ${p.ts}`,
    `base_hash: ${p.baseHash}`,
    ...(p.resolution !== undefined ? [`resolution: ${p.resolution.replace(/\n/g, " ")}`] : []),
    "---",
  ];
  return [
    ...fm,
    "",
    "## Rationale",
    "",
    p.rationale,
    "",
    "## Proposed body",
    "",
    "```markdown",
    p.body,
    "```",
    "",
  ].join("\n");
}

export function parseProposal(text: string): Proposal | null {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const fields: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  const rationale = text.match(/## Rationale\n\n([\s\S]*?)\n\n## Proposed body/)?.[1] ?? "";
  const body = text.match(/```markdown\n([\s\S]*?)\n```/)?.[1] ?? "";
  if (!fields.id || !fields.doc || !fields.status || !fields.ts || !fields.base_hash) return null;
  return {
    id: fields.id,
    doc: fields.doc as ProposableDoc,
    status: fields.status as Proposal["status"],
    ts: fields.ts,
    baseHash: fields.base_hash,
    rationale,
    body,
    resolution: fields.resolution,
  };
}
