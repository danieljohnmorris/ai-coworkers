import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openReactions, renderReactions } from "./reactions.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "react-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("openReactions", () => {
  it("returns empty arrays when the log doesn't exist yet", () => {
    const r = openReactions(join(dir, "reactions.log"));
    expect(r.read()).toEqual([]);
    expect(r.unread()).toEqual([]);
    r.markAllRead(); // no-op, must not throw
  });

  it("append + unread + markAllRead round-trip", () => {
    const r = openReactions(join(dir, "reactions.log"));
    r.append({ verdict: "👍", note: "clean handoff" });
    r.append({ verdict: "👎" });
    expect(r.unread().map((x) => x.verdict)).toEqual(["👍", "👎"]);
    expect(r.unread()[0].note).toBe("clean handoff");
    r.markAllRead();
    expect(r.unread()).toEqual([]);
    // read() still returns the whole history
    expect(r.read().length).toBe(2);
  });

  it("unread only surfaces reactions appended after the last markAllRead", () => {
    const r = openReactions(join(dir, "reactions.log"));
    r.append({ verdict: "👍" });
    r.markAllRead();
    r.append({ verdict: "👎", note: "actually no" });
    const un = r.unread();
    expect(un).toHaveLength(1);
    expect(un[0].verdict).toBe("👎");
  });

  it("skips malformed JSONL lines silently", () => {
    const path = join(dir, "reactions.log");
    const r = openReactions(path);
    r.append({ verdict: "👍" });
    // Corrupt the file with a broken line and an invalid verdict.
    const orig = readFileSync(path, "utf8");
    require("node:fs").writeFileSync(path, orig + "not-json\n" + JSON.stringify({ ts: "x", verdict: "meh" }) + "\n");
    expect(r.read()).toHaveLength(1);
  });

  it("uses the provided ts when append is called with one", () => {
    const r = openReactions(join(dir, "reactions.log"));
    r.append({ verdict: "👍", ts: "2026-01-01T00:00:00.000Z" });
    expect(r.read()[0].ts).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("renderReactions", () => {
  it("returns empty string for no reactions", () => {
    expect(renderReactions([])).toBe("");
  });

  it("renders one bullet per reaction with optional note", () => {
    const out = renderReactions([
      { ts: "2026-08-06T09:15:00.000Z", verdict: "👍", note: "keep going" },
      { ts: "2026-08-06T10:22:00.000Z", verdict: "👎" },
    ]);
    expect(out).toContain("- 👍 [09:15] — keep going");
    expect(out).toContain("- 👎 [10:22]");
  });
});
