// Coverage for the memory.note freeform scratchpad and memory.notes_read.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { memoryNote, memoryNotesRead } from "./memory.ts";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";

const NAME = "__test_memory_note__";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const NOTES = join(REPO_ROOT, "coworkers", NAME, "state", "notes.md");

function ctx(dryRun = false): ToolCtx {
  return { coworker: NAME, dryRun, env: {} as NodeJS.ProcessEnv };
}

beforeEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  mkdirSync(join(REPO_ROOT, "coworkers", NAME, "state"), { recursive: true });
});
afterEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
});

describe("memory.note", () => {
  it("dry-run returns intent, does not write", async () => {
    const r = await memoryNote.handler({ body: "AGNT retired", tag: "team" }, ctx(true)) as any;
    expect(r.dryRun).toBe(true);
    expect(r.wouldNote).toEqual({ chars: "AGNT retired".length, tag: "team" });
    expect(existsSync(NOTES)).toBe(false);
  });

  it("live write appends timestamped entry with tag, creating the file", async () => {
    const r = await memoryNote.handler({ body: "AGNT retired", tag: "team" }, ctx()) as any;
    expect(r.accepted).toBe(true);
    const text = readFileSync(NOTES, "utf8");
    expect(text).toMatch(/\n## \d{4}-\d{2}-\d{2}T[\d:.]+Z {2}\[team\]\nAGNT retired\n/);
  });

  it("appends missing tag as [] and trims whitespace", async () => {
    await memoryNote.handler({ body: "  padded  " }, ctx()) as any;
    const text = readFileSync(NOTES, "utf8");
    expect(text).toMatch(/\[\]\npadded\n$/);
  });

  it("rejects empty / whitespace-only body", async () => {
    const r = await memoryNote.handler({ body: "   " }, ctx()) as any;
    expect(r.accepted).toBe(false);
    expect(existsSync(NOTES)).toBe(false);
  });

  it("dedupes when last entry's body matches exactly", async () => {
    await memoryNote.handler({ body: "same thought" }, ctx());
    const before = readFileSync(NOTES, "utf8");
    const r = await memoryNote.handler({ body: "same thought", tag: "different" }, ctx()) as any;
    expect(r.deduped).toBe(true);
    expect(readFileSync(NOTES, "utf8")).toBe(before);
  });

  it("caps notes.md at 4096 bytes, trimming from oldest whole entry", async () => {
    // Seed with a big, obviously-old entry to force trimming.
    const bigOld = `\n## 2000-01-01T00:00:00.000Z  [old]\n${"x".repeat(4090)}\n`;
    writeFileSync(NOTES, bigOld);
    const r = await memoryNote.handler({ body: "fresh note" }, ctx()) as any;
    expect(r.accepted).toBe(true);
    const text = readFileSync(NOTES, "utf8");
    expect(text.length).toBeLessThanOrEqual(4096);
    // Newest preserved, oldest gone.
    expect(text).toContain("fresh note");
    expect(text).not.toContain("[old]");
    // Trim happens on entry boundaries — no orphan "xxx" prefix without a header.
    expect(text.startsWith("\n## ")).toBe(true);
  });

  it("keeps the newest entry even if it alone exceeds the cap", async () => {
    const huge = "y".repeat(5000);
    const r = await memoryNote.handler({ body: huge }, ctx()) as any;
    expect(r.accepted).toBe(true);
    const text = readFileSync(NOTES, "utf8");
    // The lone new entry is kept; single-entry files are not truncated mid-line.
    expect(text).toContain(huge);
  });

  it("inputSchema requires body and forbids empty via minLength", () => {
    const schema = memoryNote.inputSchema as any;
    expect(schema.required).toContain("body");
    expect(schema.properties.body.minLength).toBe(1);
  });
});

describe("memory.notes_read", () => {
  it("returns empty string when notes.md is missing", async () => {
    const r = await memoryNotesRead.handler({}, ctx()) as any;
    expect(r.content).toBe("");
  });

  it("returns full contents when no grep given", async () => {
    await memoryNote.handler({ body: "first" }, ctx());
    await memoryNote.handler({ body: "second" }, ctx());
    const r = await memoryNotesRead.handler({}, ctx()) as any;
    expect(r.content).toContain("first");
    expect(r.content).toContain("second");
  });

  it("filters to entries whose body matches grep (case-insensitive)", async () => {
    await memoryNote.handler({ body: "alpha keeper" }, ctx());
    await memoryNote.handler({ body: "beta discard" }, ctx());
    await memoryNote.handler({ body: "gamma KEEPER" }, ctx());
    const r = await memoryNotesRead.handler({ grep: "keeper" }, ctx()) as any;
    expect(r.content).toContain("alpha keeper");
    expect(r.content).toContain("gamma KEEPER");
    expect(r.content).not.toContain("beta discard");
  });

  it("grep with no matches returns empty string", async () => {
    await memoryNote.handler({ body: "one" }, ctx());
    const r = await memoryNotesRead.handler({ grep: "zzz" }, ctx()) as any;
    expect(r.content).toBe("");
  });
});
