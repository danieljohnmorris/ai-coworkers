import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openBranchRoom, sanitizeBranch } from "./branch_room.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "branchroom-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sanitizeBranch", () => {
  it("flattens slashes to double-underscore", () => {
    expect(sanitizeBranch("feat/parser-cleanup")).toBe("feat__parser-cleanup");
    expect(sanitizeBranch("release/1.2.3")).toBe("release__1.2.3");
  });
  it("rejects names with disallowed characters", () => {
    expect(() => sanitizeBranch("../etc/passwd")).toThrow();
    expect(() => sanitizeBranch("has space")).toThrow();
    expect(() => sanitizeBranch("has;semicolon")).toThrow();
  });
});

describe("openBranchRoom", () => {
  it("ensure() creates a file with a header when the branch is new", () => {
    const room = openBranchRoom(dir);
    room.ensure("feat/x");
    const p = room.path("feat/x");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("# Branch: feat/x");
    expect(text).toContain("Opened ");
  });

  it("ensure() is idempotent — does not clobber an existing file", () => {
    const room = openBranchRoom(dir);
    room.ensure("feat/x");
    room.append("feat/x", { kind: "note", by: "alex", body: "seed" });
    const before = readFileSync(room.path("feat/x"), "utf8");
    room.ensure("feat/x");
    const after = readFileSync(room.path("feat/x"), "utf8");
    expect(after).toBe(before);
    expect(after).toContain("seed");
  });

  it("append() lazily creates the room + writes the entry with header + icon", () => {
    const room = openBranchRoom(dir);
    room.append("fix-42", { kind: "patch", by: "alex", body: "removed dead branch in parser" });
    const text = room.read("fix-42");
    expect(text).toContain("# Branch: fix-42");
    expect(text).toContain("🩹 patch");
    expect(text).toContain("by alex");
    expect(text).toContain("removed dead branch");
  });

  it("read() returns '' for an unknown branch", () => {
    expect(openBranchRoom(dir).read("nope")).toBe("");
  });

  it("list() returns rooms newest-updated first, decoding flattened slashes", async () => {
    const room = openBranchRoom(dir);
    room.append("feat/a", { kind: "note", by: "alex", body: "first" });
    // Ensure a distinct mtime ordering — some filesystems have coarse mtime.
    await new Promise((r) => setTimeout(r, 20));
    room.append("feat/b", { kind: "note", by: "alex", body: "second" });
    const rooms = room.list();
    expect(rooms.map((r) => r.branch)).toEqual(["feat/b", "feat/a"]);
    expect(rooms[0].sizeBytes).toBeGreaterThan(0);
  });

  it("list() returns [] when the base dir doesn't exist yet", () => {
    const room = openBranchRoom(join(dir, "not-yet"));
    expect(room.list()).toEqual([]);
  });
});
