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
