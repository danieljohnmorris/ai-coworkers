import { describe, it, expect, beforeEach } from "vitest";
import { loadHermesSkills, renderSkillsIndex } from "./hermes.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skills-")); });

function seed(name: string, front: string, body: string) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\n${front}\n---\n${body}`);
}

describe("loadHermesSkills", () => {
  it("returns [] for a missing dir", () => {
    expect(loadHermesSkills("/nonexistent-xyz")).toEqual([]);
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    expect(loadHermesSkills(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses front-matter name and description", () => {
    seed("apple-notes", 'name: apple-notes\ndescription: Read and write Apple Notes', "body");
    const s = loadHermesSkills(dir);
    expect(s.length).toBe(1);
    expect(s[0].name).toBe("apple-notes");
    expect(s[0].description).toContain("Apple Notes");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to dir name if front-matter missing", () => {
    mkdirSync(join(dir, "raw"), { recursive: true });
    writeFileSync(join(dir, "raw", "SKILL.md"), "Just a body, no front matter.");
    const s = loadHermesSkills(dir);
    expect(s[0].name).toBe("raw");
    expect(s[0].description).toContain("Just a body");
    rmSync(dir, { recursive: true, force: true });
  });

  it("recurses into category subdirs (Hermes-style productivity/google-workspace layout)", () => {
    // Real Hermes lays skills out as ~/.hermes/skills/<category>/<skill>/SKILL.md
    // — a flat scan misses everything below the first level. Regression
    // test for that discovery.
    mkdirSync(join(dir, "productivity", "google-workspace"), { recursive: true });
    mkdirSync(join(dir, "productivity", "airtable"), { recursive: true });
    mkdirSync(join(dir, "creativity", "manim"), { recursive: true });
    writeFileSync(join(dir, "productivity", "google-workspace", "SKILL.md"), "---\nname: google-workspace\ndescription: Gmail + Docs via OAuth\n---\nbody");
    writeFileSync(join(dir, "productivity", "airtable", "SKILL.md"), "---\nname: airtable\ndescription: Airtable CLI\n---\nbody");
    writeFileSync(join(dir, "creativity", "manim", "SKILL.md"), "---\nname: manim\ndescription: Manim animations\n---\nbody");
    const s = loadHermesSkills(dir);
    const names = s.map((x) => x.name).sort();
    expect(names).toEqual(["airtable", "google-workspace", "manim"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips regular files at top level and broken symlinks", () => {
    // A stray file → not a directory, skipped.
    writeFileSync(join(dir, "loose.md"), "not a skill");
    // A broken symlink → statSync throws, caught silently.
    const { symlinkSync } = require("node:fs");
    try { symlinkSync(join(dir, "no-such-target"), join(dir, "broken-link")); } catch { /* ignore if not permitted */ }
    // A real skill still loads.
    seed("ok", "name: ok\ndescription: works", "body");
    const s = loadHermesSkills(dir);
    expect(s.map((x) => x.name)).toContain("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("parseFrontMatter falls back cleanly when body is empty (firstLine)", () => {
    // Frontmatter with no description → firstLine of empty body returns "".
    seed("empty", "name: empty", "");
    const s = loadHermesSkills(dir);
    expect(s[0].name).toBe("empty");
    expect(s[0].description).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT recurse into a skill's own scripts/ or references/ subdirs", () => {
    // A skill's own subdirectories (scripts/, references/) are its
    // implementation, not nested skills. Stopping recursion at the first
    // SKILL.md found prevents spurious duplicate entries when a nested
    // dir happens to contain another markdown file called SKILL.md.
    mkdirSync(join(dir, "productivity", "google-workspace", "scripts"), { recursive: true });
    writeFileSync(join(dir, "productivity", "google-workspace", "SKILL.md"), "---\nname: google-workspace\ndescription: outer\n---\nx");
    writeFileSync(join(dir, "productivity", "google-workspace", "scripts", "SKILL.md"), "---\nname: BAD-nested\ndescription: should not be loaded\n---\nx");
    const s = loadHermesSkills(dir);
    expect(s.map((x) => x.name)).toEqual(["google-workspace"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderSkillsIndex", () => {
  it("returns empty string on no skills", () => {
    expect(renderSkillsIndex([])).toBe("");
  });

  it("renders one bullet per skill", () => {
    const out = renderSkillsIndex([
      { name: "a", description: "does a", path: "/x", body: "" },
      { name: "b", description: "does b", path: "/y", body: "" },
    ]);
    expect(out).toContain("- **a**");
    expect(out).toContain("- **b**");
    expect(out).toContain("SKILLS (procedural memory");
  });

  it("inlines full body for activated skills", () => {
    const out = renderSkillsIndex(
      [
        { name: "a", description: "does a", path: "/x", body: "APPLY RULES A" },
        { name: "b", description: "does b", path: "/y", body: "unused body" },
      ],
      ["a"],
    );
    expect(out).toContain("## Active skills");
    expect(out).toContain("### a");
    expect(out).toContain("APPLY RULES A");
    expect(out).not.toContain("unused body");
  });
});
