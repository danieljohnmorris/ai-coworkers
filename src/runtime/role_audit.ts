// AIC-78 — role-doc drift audit. Once a day, re-parse every role doc and
// compare against the last-known-good snapshot. Escalate if anything
// suspicious happened: parse regressions, "Must not touch" list shrank,
// resource-limit caps raised. Growth (more restrictions, tighter caps)
// is fine and doesn't alert. This exists because BOUNDARIES.md is the
// most safety-critical file in the coworker directory, and silent edits
// (accidental or malicious) shouldn't wait until the next boot warning.
//
// Snapshots live at coworkers/<name>/state/audit/snapshots/<DOC>.md and
// hold the exact content that was last audited-and-approved. A findings
// log at coworkers/<name>/state/audit/findings.log records every
// audit run's outcome.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const AUDITED_DOCS = [
  "ROLE",
  "RESPONSIBILITIES",
  "AUTHORITY",
  "BOUNDARIES",
  "RITUALS",
  "RELATIONSHIPS",
  "TOOLS",
  "WORKSPACE",
] as const;

export type AuditedDoc = (typeof AUDITED_DOCS)[number];

export interface AuditFinding {
  doc: AuditedDoc;
  severity: "info" | "warn" | "critical";
  message: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  snapshotsUpdated: AuditedDoc[];
  ts: string;
}

export interface RoleAuditPaths {
  roleDir: string;         // coworkers/<name>/role
  snapshotDir: string;     // coworkers/<name>/state/audit/snapshots
  findingsLog: string;     // coworkers/<name>/state/audit/findings.log
}

// Extract "Must not touch" bullets from BOUNDARIES.md text (case-insensitive
// header match). Returns list of trimmed bullet strings, empty if section
// absent. Used by drift-detection to notice if any hard limit disappeared.
export function extractMustNotTouch(text: string): string[] {
  const m = text.match(/##\s*Must not touch\s*\n([\s\S]*?)(?:\n##|\n#|$)/i);
  if (!m) return [];
  return m[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Extract "Max LLM calls per day: N" etc. Returns a map of the caps we
// track — a value going UP is suspicious (looser).
export function extractCaps(text: string): Record<string, number> {
  const patterns: [string, RegExp][] = [
    ["maxLlmPerDay",           /max\s+LLM\s+calls\s+per\s+day:\s*(\d+)/i],
    ["maxLlmPerWindow",        /max\s+LLM\s+calls\s+per\s+\d+h\s+window:\s*(\d+)/i],
    ["maxWorktrees",           /max\s+concurrent\s+worktrees:\s*(\d+)/i],
    ["maxWorktreeAgeHours",    /max\s+worktree\s+age:\s*(\d+)\s*h/i],
    ["maxDiskMB",              /max\s+disk\s+usage:\s*(\d+)\s*(?:mb|gb)/i],
    ["killSubprocessIdleMin",  /kill\s+subprocesses\s+idle\s*>\s*(\d+)\s*min/i],
  ];
  const out: Record<string, number> = {};
  for (const [name, re] of patterns) {
    const m = text.match(re);
    if (m) out[name] = Number(m[1]);
  }
  return out;
}

function readCurrent(roleDir: string, doc: AuditedDoc): string {
  const p = join(roleDir, `${doc}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function readSnapshot(snapshotDir: string, doc: AuditedDoc): string | null {
  const p = join(snapshotDir, `${doc}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function writeSnapshot(snapshotDir: string, doc: AuditedDoc, body: string): void {
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, `${doc}.md`), body);
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

export function auditRoleDocs(paths: RoleAuditPaths, opts: { now?: Date } = {}): AuditResult {
  const findings: AuditFinding[] = [];
  const snapshotsUpdated: AuditedDoc[] = [];
  const ts = (opts.now ?? new Date()).toISOString();

  for (const doc of AUDITED_DOCS) {
    const current = readCurrent(paths.roleDir, doc).trim();
    const snap = readSnapshot(paths.snapshotDir, doc);

    // First run — seed snapshot without alerting. Genuine first-boot
    // shouldn't page anyone; the operator authored these on purpose.
    if (snap === null) {
      if (current) {
        writeSnapshot(paths.snapshotDir, doc, current);
        snapshotsUpdated.push(doc);
        findings.push({ doc, severity: "info", message: `first snapshot written (hash ${shortHash(current)})` });
      }
      continue;
    }

    // No change → nothing to report.
    if (shortHash(current) === shortHash(snap.trim())) continue;

    // Something changed. Classify.
    const critical: string[] = [];
    const warns: string[] = [];

    // Rule 1: doc disappeared or blanked out.
    if (current.length === 0 && snap.trim().length > 0) {
      critical.push(`doc is now empty (was ${snap.trim().length} chars)`);
    }

    // Rule 2: BOUNDARIES — Must-not-touch list shrank.
    if (doc === "BOUNDARIES") {
      const prevList = extractMustNotTouch(snap);
      const nowList = extractMustNotTouch(current);
      const missing = prevList.filter((p) => !nowList.includes(p));
      if (missing.length) {
        critical.push(`Must-not-touch entries removed: ${missing.slice(0, 5).map((m) => `"${m.slice(0, 60)}"`).join("; ")}`);
      }
      // Rule 3: any cap value raised.
      const prevCaps = extractCaps(snap);
      const nowCaps = extractCaps(current);
      for (const [k, v] of Object.entries(nowCaps)) {
        const p = prevCaps[k];
        if (p !== undefined && v > p) critical.push(`${k} raised: ${p} → ${v}`);
        if (p !== undefined && v < p) warns.push(`${k} tightened: ${p} → ${v} (ok)`);
      }
      for (const [k, v] of Object.entries(prevCaps)) {
        if (!(k in nowCaps)) critical.push(`cap "${k}" removed entirely (was ${v})`);
      }
    }

    // Anything else is worth noting but not paging.
    if (!critical.length && !warns.length) {
      warns.push(`content changed (${snap.trim().length} → ${current.length} chars)`);
    }

    for (const msg of critical) findings.push({ doc, severity: "critical", message: msg });
    for (const msg of warns)    findings.push({ doc, severity: "warn",     message: msg });

    // Do NOT auto-update the snapshot when there are critical findings —
    // that would silently accept a suspicious edit. Operator must
    // acknowledge (via bin/audit-accept.sh below) to advance the snapshot.
    if (!critical.length) {
      writeSnapshot(paths.snapshotDir, doc, current);
      snapshotsUpdated.push(doc);
    }
  }

  // Persist findings to disk regardless of severity.
  mkdirSync(join(paths.findingsLog, "..") , { recursive: true });
  appendFileSync(paths.findingsLog, JSON.stringify({ ts, findings, snapshotsUpdated }) + "\n");

  return { findings, snapshotsUpdated, ts };
}
