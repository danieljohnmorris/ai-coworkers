import { describe, it, expect, beforeEach } from "vitest";
import { openEntities } from "./entities.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ent-al-")); });

describe("entities.detect with frontmatter aliases (AIC-37)", () => {
  it("detects a person by any declared alias", () => {
    const e = openEntities(dir);
    e.upsertPerson("dan", "aliases: [dan_slack, dj]\n\nprefers small PRs", "test");
    const hits = e.detect("today @dan_slack asked about parser");
    expect(hits.people).toContain("dan");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to canonical name when no aliases", () => {
    const e = openEntities(dir);
    e.upsertPerson("alice", "just some notes", "test");
    expect(e.detect("alice replied").people).toContain("alice");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not match on unrelated text", () => {
    const e = openEntities(dir);
    e.upsertPerson("dan", "aliases: [dan_slack]\n\nx", "test");
    expect(e.detect("nothing to see here").people).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns canonical handle, not the matched alias", () => {
    const e = openEntities(dir);
    e.upsertPerson("dan", "aliases: [dan_slack]\n\nx", "test");
    const hits = e.detect("dan_slack said hi");
    expect(hits.people).toEqual(["dan"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
