import { describe, it, expect } from "vitest";
import { loadRole } from "./role.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scaffold(files: Record<string, string>): { root: string; name: string } {
  const root = mkdtempSync(join(tmpdir(), "role-"));
  const name = "test-worker";
  const roleDir = join(root, name, "role");
  mkdirSync(roleDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(roleDir, k), v);
  return { root, name };
}

describe("loadRole", () => {
  it("concatenates present docs into the system prompt with headings", () => {
    const { root, name } = scaffold({
      "ROLE.md": "You are Alex.",
      "RESPONSIBILITIES.md": "- Triage tickets.",
      "TOOLS.md": "- linear",
    });
    const r = loadRole(root, name);
    expect(r.systemPrompt).toContain("# ROLE\n\nYou are Alex.");
    expect(r.systemPrompt).toContain("# RESPONSIBILITIES");
    expect(r.systemPrompt).toContain("# TOOLS");
    // Missing docs are skipped
    expect(r.systemPrompt).not.toContain("# BOUNDARIES");
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to defaults when BOUNDARIES has no limits section", () => {
    const { root, name } = scaffold({ "BOUNDARIES.md": "no limits here" });
    const r = loadRole(root, name);
    expect(r.limits.maxWorktrees).toBe(5);
    expect(r.limits.maxWorktreeAgeHours).toBe(24);
    expect(r.limits.maxDiskMB).toBe(5120);
    expect(r.limits.killSubprocessIdleMin).toBe(30);
    rmSync(root, { recursive: true, force: true });
  });

  it("parses explicit resource limits from BOUNDARIES.md", () => {
    const { root, name } = scaffold({
      "BOUNDARIES.md": [
        "## Resource limits",
        "- Max concurrent worktrees: 0",
        "- Max worktree age: 12 h",
        "- Max disk usage: 100 MB",
        "- Kill subprocesses idle > 15 min",
      ].join("\n"),
    });
    const r = loadRole(root, name);
    expect(r.limits.maxWorktrees).toBe(0);
    expect(r.limits.maxWorktreeAgeHours).toBe(12);
    expect(r.limits.maxDiskMB).toBe(100);
    expect(r.limits.killSubprocessIdleMin).toBe(15);
    rmSync(root, { recursive: true, force: true });
  });

  it("warns to stderr on typo'd resource-limit lines", () => {
    const { root, name } = scaffold({
      "BOUNDARIES.md": [
        "## Resource limits",
        // Near-miss form: mentions worktrees + a number, but not the strict "max concurrent worktrees: N" phrasing.
        "- max concurrent limit: 3 worktrees allowed",
      ].join("\n"),
    });
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => { chunks.push(String(s)); return true; };
    try {
      const r = loadRole(root, name);
      expect(r.limits.maxWorktrees).toBe(5);
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(chunks.join("")).toContain("possible typo in BOUNDARIES.md");
    rmSync(root, { recursive: true, force: true });
  });
});
