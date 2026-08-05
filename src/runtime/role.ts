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

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DOCS = [
  "ROLE",
  "RESPONSIBILITIES",
  "AUTHORITY",
  "BOUNDARIES",
  "RITUALS",
  "RELATIONSHIPS",
  "TOOLS",
] as const;

export type Role = {
  name: string;
  dir: string;
  docs: Record<(typeof DOCS)[number], string>;
  systemPrompt: string;
  limits: ResourceLimits;
};

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
  const systemPrompt = DOCS
    .filter((k) => docs[k])
    .map((k) => `# ${k}\n\n${docs[k]}`)
    .join("\n\n---\n\n");

  return {
    name,
    dir,
    docs,
    systemPrompt,
    limits: parseLimits(docs.BOUNDARIES) ?? DEFAULT_LIMITS,
  };
}

// Very small parser: reads "- Max concurrent worktrees: 5" style lines from
// BOUNDARIES.md. Missing values fall back to defaults.
function parseLimits(text: string): ResourceLimits | null {
  if (!text) return null;
  const num = (re: RegExp): number | undefined => {
    const m = text.match(re);
    return m ? Number(m[1]) : undefined;
  };
  return {
    maxWorktrees: num(/max concurrent worktrees:\s*(\d+)/i) ?? DEFAULT_LIMITS.maxWorktrees,
    maxWorktreeAgeHours: num(/max worktree age:\s*(\d+)\s*h/i) ?? DEFAULT_LIMITS.maxWorktreeAgeHours,
    maxDiskMB: num(/max disk usage:\s*(\d+)\s*(?:mb|gb)/i) ?? DEFAULT_LIMITS.maxDiskMB,
    killSubprocessIdleMin: num(/kill subprocesses idle\s*>\s*(\d+)\s*min/i) ?? DEFAULT_LIMITS.killSubprocessIdleMin,
  };
}
