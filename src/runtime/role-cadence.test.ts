import { describe, it, expect } from "vitest";
import { loadRole } from "./role.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scaffold(rituals: string) {
  const root = mkdtempSync(join(tmpdir(), "cad-"));
  const roleDir = join(root, "t", "role");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "RITUALS.md"), rituals);
  return { root };
}

describe("role.cadence parsing", () => {
  it("defaults to adaptive", () => {
    const { root } = scaffold("- daily standup");
    expect(loadRole(root, "t").cadence).toBe("adaptive");
    rmSync(root, { recursive: true, force: true });
  });

  it("reads 'constant' from RITUALS.md", () => {
    const { root } = scaffold("- daily standup\nCadence: constant");
    expect(loadRole(root, "t").cadence).toBe("constant");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts bulleted form", () => {
    const { root } = scaffold("- Cadence: constant");
    expect(loadRole(root, "t").cadence).toBe("constant");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts explicit 'adaptive'", () => {
    const { root } = scaffold("Cadence: adaptive");
    expect(loadRole(root, "t").cadence).toBe("adaptive");
    rmSync(root, { recursive: true, force: true });
  });
});
