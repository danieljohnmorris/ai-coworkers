// Load a coworker's role/ folder into a structured object + a system prompt.
// Role folder shape:
//   role/ROLE.md            who they are
//   role/RESPONSIBILITIES.md what they own
//   role/AUTHORITY.md       decide alone vs escalate
//   role/BOUNDARIES.md      what they must not touch (+ resource caps)
//   role/RITUALS.md         recurring scheduled behaviors
//   role/RELATIONSHIPS.md   who they work with
//   role/TOOLS.md           what tools/integrations they may use
//
// All docs are plain markdown and human-editable. The system prompt is the
// concatenation, with headings, so the coworker literally reads its own JD
// every deliberation.
//
// The coworker cannot write these files. It can suggest edits through the
// role.propose_change tool (see runtime/role-proposals.ts); a human reviews
// with bin/review-proposal.sh and accepting applies the change here.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompts",
  "coworker_baseline.md",
);

const DOCS = [
  "ROLE",
  "RESPONSIBILITIES",
  "AUTHORITY",
  "BOUNDARIES",
  "RITUALS",
  "RELATIONSHIPS",
  "TOOLS",
  "WORKSPACE",           // stable, human-authored context about the world the coworker operates in
] as const;

export type Role = {
  name: string;
  dir: string;
  docs: Record<(typeof DOCS)[number], string>;
  baseline: string;
  systemPrompt: string;
  limits: ResourceLimits;
  cadence: Cadence;
};

export type Cadence = "adaptive" | "constant";

export interface ResourceLimits {
  maxWorktrees: number;
  maxWorktreeAgeHours: number;
  maxDiskMB: number;
  killSubprocessIdleMin: number;
}

const DEFAULT_LIMITS: ResourceLimits = {
  maxWorktrees: 5,
  maxWorktreeAgeHours: 24,
  maxDiskMB: 5120,
  killSubprocessIdleMin: 30,
};

export function loadRole(coworkersDir: string, name: string): Role {
  const dir = join(coworkersDir, name, "role");
  const docs = {} as Role["docs"];
  for (const key of DOCS) {
    const p = join(dir, `${key}.md`);
    docs[key] = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  }
  const roleBody = DOCS
    .filter((k) => docs[k])
    .map((k) => `# ${k}\n\n${docs[k]}`)
    .join("\n\n---\n\n");

  const baseline = loadBaseline(roleBody);
  const systemPrompt = baseline
    ? `# baseline\n\n${baseline}\n\n---\n\n${roleBody}`
    : roleBody;

  return {
    name,
    dir,
    docs,
    baseline,
    systemPrompt,
    limits: parseLimits(docs.BOUNDARIES) ?? DEFAULT_LIMITS,
    cadence: parseCadence(docs.RITUALS),
  };
}

// Read the framework-owned baseline, strip any `## <heading>` block whose
// heading also appears in the concatenated role body. This lets a role
// override a baseline section by naming the same header (kebab-case).
// Escape hatch: COWORKER_SKIP_BASELINE=1 disables the baseline entirely.
function loadBaseline(roleBody: string): string {
  if (process.env.COWORKER_SKIP_BASELINE === "1") return "";
  if (!existsSync(BASELINE_PATH)) return "";
  const raw = readFileSync(BASELINE_PATH, "utf8").trim();
  const roleHeadings = new Set(
    Array.from(roleBody.matchAll(/^##\s+(\S.*?)\s*$/gm)).map((m) => m[1].trim().toLowerCase()),
  );
  if (roleHeadings.size === 0) return raw;

  // Split baseline into (preamble)(## heading blocks)
  const parts: string[] = [];
  const headerRe = /^##\s+(\S.*?)\s*$/gm;
  const marks: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw)) !== null) {
    marks.push({ name: m[1].trim().toLowerCase(), start: m.index });
  }
  if (marks.length === 0) return raw;

  parts.push(raw.slice(0, marks[0].start).trimEnd());
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    if (roleHeadings.has(marks[i].name)) continue; // role overrides
    parts.push(raw.slice(marks[i].start, end).trimEnd());
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

// Cadence is declared in RITUALS.md — a line like "Cadence: constant" opts
// the coworker out of adaptive backoff (e.g. a monitoring or on-call role
// that must poll on a fixed interval). Default is adaptive.
function parseCadence(ritualsMd: string): Cadence {
  const m = ritualsMd.match(/^\s*(?:-\s*)?cadence:\s*(constant|adaptive)\b/im);
  return (m?.[1]?.toLowerCase() as Cadence) ?? "adaptive";
}

// Very small parser: reads "- Max concurrent worktrees: 5" style lines from
// BOUNDARIES.md. Missing values fall back to defaults. AIC-59 — collect
// warnings for lines that LOOK like limit declarations but don't parse, so
// typos like "Max LLM callz per day: 500" don't silently revert to default.
function parseLimits(text: string): ResourceLimits | null {
  if (!text) return null;
  const warnings: string[] = [];
  const num = (re: RegExp, name: string): number | undefined => {
    const m = text.match(re);
    if (m) return Number(m[1]);
    // Detect near-misses: a line beginning with "max " under "Resource limits"
    // that mentions our concept but didn't match the regex.
    const near = new RegExp(`(max\\s+\\w[\\w\\s]*|kill\\s+\\w[\\w\\s]*)\\s*:\\s*\\d+.*?${name}?`, "i");
    if (near.test(text) && !text.match(re)) {
      warnings.push(`possible typo in BOUNDARIES.md near "${name}" — falling back to default`);
    }
    return undefined;
  };
  const limits = {
    maxWorktrees: num(/max concurrent worktrees:\s*(\d+)/i, "worktrees") ?? DEFAULT_LIMITS.maxWorktrees,
    maxWorktreeAgeHours: num(/max worktree age:\s*(\d+)\s*h/i, "worktree age") ?? DEFAULT_LIMITS.maxWorktreeAgeHours,
    maxDiskMB: num(/max disk usage:\s*(\d+)\s*(?:mb|gb)/i, "disk") ?? DEFAULT_LIMITS.maxDiskMB,
    killSubprocessIdleMin: num(/kill subprocesses idle\s*>\s*(\d+)\s*min/i, "subprocess") ?? DEFAULT_LIMITS.killSubprocessIdleMin,
  };
  if (warnings.length) {
    // Emit to stderr so it's visible at startup; runtime tick logs its own
    // warnings via log.event elsewhere.
    for (const w of warnings) process.stderr.write(`WARN role.parseLimits: ${w}\n`);
  }
  return limits;
}
