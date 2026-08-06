import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { auditRoleDocs, extractMustNotTouch, extractCaps } from "./role_audit.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let paths: { roleDir: string; snapshotDir: string; findingsLog: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-"));
  paths = {
    roleDir: join(dir, "role"),
    snapshotDir: join(dir, "state", "audit", "snapshots"),
    findingsLog: join(dir, "state", "audit", "findings.log"),
  };
  mkdirSync(paths.roleDir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedBoundaries(text: string) {
  writeFileSync(join(paths.roleDir, "BOUNDARIES.md"), text);
}

describe("extractMustNotTouch", () => {
  it("parses bullet list under ## Must not touch", () => {
    const list = extractMustNotTouch(`## Must not touch\n- secret\n- production\n\n## Resource limits\n- Max LLM calls per day: 500`);
    expect(list).toEqual(["secret", "production"]);
  });
  it("returns [] when the section is absent", () => {
    expect(extractMustNotTouch("no such section here")).toEqual([]);
  });
});

describe("extractCaps", () => {
  it("pulls out every known cap it can find", () => {
    const caps = extractCaps([
      "## Resource limits",
      "- Max concurrent worktrees: 3",
      "- Max worktree age: 24 h",
      "- Max disk usage: 512 MB",
      "- Kill subprocesses idle > 30 min",
      "- Max LLM calls per day: 500",
      "- Max LLM calls per 5h window: 200",
    ].join("\n"));
    expect(caps).toEqual({
      maxWorktrees: 3, maxWorktreeAgeHours: 24, maxDiskMB: 512,
      killSubprocessIdleMin: 30, maxLlmPerDay: 500, maxLlmPerWindow: 200,
    });
  });
});

describe("auditRoleDocs", () => {
  it("seeds snapshots on the first run without alerting", () => {
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
    const r = auditRoleDocs(paths);
    expect(r.snapshotsUpdated).toContain("BOUNDARIES");
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
    expect(existsSync(join(paths.snapshotDir, "BOUNDARIES.md"))).toBe(true);
  });

  it("no findings when nothing changed", () => {
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
    auditRoleDocs(paths);
    const r = auditRoleDocs(paths);
    expect(r.findings).toEqual([]);
  });

  it("critical: BOUNDARIES entry removed from Must-not-touch", () => {
    seedBoundaries("## Must not touch\n- secret\n- production\n\n## Resource limits\n- Max LLM calls per day: 500");
    auditRoleDocs(paths);
    // Someone drops "production"
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
    const r = auditRoleDocs(paths);
    const critical = r.findings.filter((f) => f.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
    expect(critical[0].message).toContain("Must-not-touch entries removed");
    // Snapshot NOT updated — needs human accept.
    expect(readFileSync(join(paths.snapshotDir, "BOUNDARIES.md"), "utf8")).toContain("production");
  });

  it("critical: LLM per-day cap raised", () => {
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
    auditRoleDocs(paths);
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 5000");
    const r = auditRoleDocs(paths);
    expect(r.findings.some((f) => f.severity === "critical" && f.message.includes("raised"))).toBe(true);
  });

  it("does NOT alert when caps are tightened (lower is fine)", () => {
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500");
    auditRoleDocs(paths);
    seedBoundaries("## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 100");
    const r = auditRoleDocs(paths);
    expect(r.findings.some((f) => f.severity === "critical")).toBe(false);
    // Should be a warn recording the tightening.
    expect(r.findings.some((f) => f.severity === "warn" && /tightened/i.test(f.message))).toBe(true);
  });

  it("critical: doc blanked out entirely", () => {
    seedBoundaries("## Must not touch\n- secret\n");
    auditRoleDocs(paths);
    seedBoundaries("");
    const r = auditRoleDocs(paths);
    expect(r.findings.some((f) => f.severity === "critical" && /empty/.test(f.message))).toBe(true);
  });

  it("appends every run's outcome to findings.log", () => {
    seedBoundaries("## Must not touch\n- secret\n");
    auditRoleDocs(paths);
    auditRoleDocs(paths);
    const lines = readFileSync(paths.findingsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
