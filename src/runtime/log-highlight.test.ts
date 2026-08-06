import { describe, it, expect, beforeEach } from "vitest";
import { openEvents, Log, tailHighlights } from "./log.ts";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "loghi-")); });

describe("Log.highlight + tailHighlights", () => {
  it("stream(line) writes only to stream file", () => {
    const events = openEvents(join(dir, "e.db"));
    const streamPath = join(dir, "stream.log");
    const highlightPath = join(dir, "hi.log");
    const l = new Log(events, "t", { streamPath, highlightPath });
    l.stream("noise");
    expect(readFileSync(streamPath, "utf8")).toContain("noise");
    expect(existsSync(highlightPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("highlight(line) writes to both files", () => {
    const events = openEvents(join(dir, "e.db"));
    const streamPath = join(dir, "stream.log");
    const highlightPath = join(dir, "hi.log");
    const l = new Log(events, "t", { streamPath, highlightPath });
    l.highlight("important");
    expect(readFileSync(streamPath, "utf8")).toContain("important");
    expect(readFileSync(highlightPath, "utf8")).toContain("important");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tailHighlights returns empty for missing file", () => {
    expect(tailHighlights("/tmp/does-not-exist-xyz.log")).toBe("");
  });

  it("tailHighlights returns last N lines", () => {
    const events = openEvents(join(dir, "e.db"));
    const highlightPath = join(dir, "hi.log");
    const l = new Log(events, "t", { highlightPath });
    for (let i = 0; i < 30; i++) l.highlight(`event ${i}`);
    const tail = tailHighlights(highlightPath, 5);
    const lines = tail.split("\n");
    expect(lines.length).toBe(5);
    expect(tail).toContain("event 29");
    expect(tail).not.toContain("event 20");
    rmSync(dir, { recursive: true, force: true });
  });

  it("LOG_FORMAT=json emits structured JSON lines", () => {
    const events = openEvents(join(dir, "e.db"));
    const highlightPath = join(dir, "hi.log");
    const l = new Log(events, "cw", { highlightPath });
    const prev = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    try {
      l.highlight("hello");
    } finally {
      if (prev === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = prev;
    }
    const line = readFileSync(highlightPath, "utf8").trim();
    const obj = JSON.parse(line);
    expect(obj.msg).toBe("hello");
    expect(obj.coworker).toBe("cw");
    expect(obj.level).toBe("highlight");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tailHighlights returns empty when read throws (path is a directory)", () => {
    // existsSync(dir) is true but readFileSync(dir) throws EISDIR — exercises the catch.
    expect(tailHighlights(dir)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
