import { describe, it, expect, beforeEach } from "vitest";
import { loadEveAgent } from "./eve.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eve-")); });

describe("loadEveAgent", () => {
  it("returns null for missing dir", () => {
    expect(loadEveAgent("/nope-xyz")).toBeNull();
  });

  it("loads instructions + skills + tools/channels/schedules listings", () => {
    writeFileSync(join(dir, "instructions.md"), "you are eve");
    mkdirSync(join(dir, "skills"), { recursive: true });
    mkdirSync(join(dir, "skills", "greet"), { recursive: true });
    writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: say hi\n---\nbody");
    mkdirSync(join(dir, "tools")); writeFileSync(join(dir, "tools", "post.ts"), "//");
    mkdirSync(join(dir, "channels")); writeFileSync(join(dir, "channels", "slack.md"), "-");
    mkdirSync(join(dir, "schedules")); writeFileSync(join(dir, "schedules", "daily.md"), "-");
    const a = loadEveAgent(dir);
    expect(a?.instructions).toContain("eve");
    expect(a?.skills[0]?.name).toBe("greet");
    expect(a?.toolFiles).toContain("post.ts");
    expect(a?.channels).toContain("slack.md");
    expect(a?.schedules).toContain("daily.md");
    rmSync(dir, { recursive: true, force: true });
  });
});
