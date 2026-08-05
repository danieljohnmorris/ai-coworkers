import { describe, it, expect, beforeEach } from "vitest";
import { openEvents } from "./log.ts";
import { initEpisodic, search } from "./episodic.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "epi-"));
});

describe("episodic FTS5", () => {
  it("finds an issue identifier in payload", () => {
    const db = openEvents(join(dir, "e.db"));
    initEpisodic(db);
    db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), "t", "action",
           JSON.stringify({ tool: "linear.comment", input: { issueId: "ILO-509", body: "P1?" } }));
    const hits = search(db, "ILO-509");
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe("action");
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills FTS from pre-existing events on init", () => {
    const db = openEvents(join(dir, "e.db"));
    db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), "t", "note", JSON.stringify({ msg: "startup ok" }));
    initEpisodic(db);
    expect(search(db, "startup").length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps FTS in sync when new events arrive after init", () => {
    const db = openEvents(join(dir, "e.db"));
    initEpisodic(db);
    db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), "t", "note", JSON.stringify({ msg: "later event about parser" }));
    expect(search(db, "parser").length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty on empty query", () => {
    const db = openEvents(join(dir, "e.db"));
    initEpisodic(db);
    expect(search(db, "")).toEqual([]);
    expect(search(db, "   ")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
