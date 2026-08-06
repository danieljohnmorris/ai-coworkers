import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { branchNote, branchRead, branchList } from "./branch_room.ts";
import type { ToolCtx } from "../runtime/tools.ts";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const NAME = "__test_branch_room__";
const stateDir = join(REPO_ROOT, "coworkers", NAME, "state");

beforeEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
});

const ctxDry = (): ToolCtx => ({ coworker: NAME, dryRun: true, env: process.env });
const ctxLive = (): ToolCtx => ({ coworker: NAME, dryRun: false, env: process.env });

describe("branch.note", () => {
  it("dry-run does not touch disk", async () => {
    const r = await branchNote.handler({ branch: "feat/x", kind: "note", body: "hi" }, ctxDry()) as any;
    expect(r.dryRun).toBe(true);
    expect(existsSync(join(stateDir, "branches"))).toBe(false);
  });

  it("appends to the branch narrative with the coworker as default author", async () => {
    const r = await branchNote.handler({ branch: "feat/x", kind: "patch", body: "removed lint noise" }, ctxLive()) as any;
    expect(r.ok).toBe(true);
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain("# Branch: feat/x");
    expect(text).toContain("🩹 patch");
    expect(text).toContain(`by ${NAME}`);
    expect(text).toContain("removed lint noise");
  });

  it("rejects invalid branch names", async () => {
    const r = await branchNote.handler({ branch: "../evil", kind: "note", body: "x" }, ctxLive()) as any;
    expect(r.error).toMatch(/invalid branch name/);
  });
});

describe("branch.read", () => {
  it("returns empty=true when the room does not exist", async () => {
    const r = await branchRead.handler({ branch: "not-yet" }, ctxLive()) as any;
    expect(r.empty).toBe(true);
  });

  it("returns the full narrative once created", async () => {
    await branchNote.handler({ branch: "fix-42", kind: "review", body: "LGTM" }, ctxLive());
    const r = await branchRead.handler({ branch: "fix-42" }, ctxLive()) as any;
    expect(r.body).toContain("LGTM");
  });
});

describe("branch.list", () => {
  it("returns [] before any rooms exist", async () => {
    const r = await branchList.handler({}, ctxLive()) as any;
    expect(r.branches).toEqual([]);
  });

  it("lists active rooms", async () => {
    await branchNote.handler({ branch: "feat/a", kind: "note", body: "first" }, ctxLive());
    const r = await branchList.handler({}, ctxLive()) as any;
    expect(r.branches).toHaveLength(1);
    expect(r.branches[0].branch).toBe("feat/a");
  });
});
