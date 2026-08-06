import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadRituals, BUILTIN_RITUALS } from "./rituals_loader.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rituals-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeJson = (name: string, obj: unknown): void => {
  writeFileSync(join(dir, name), JSON.stringify(obj));
};

describe("loadRituals", () => {
  it("falls back to BUILTIN_RITUALS when the dir is missing", () => {
    const r = loadRituals(join(dir, "no-such-subdir"));
    expect(r.specs).toEqual(BUILTIN_RITUALS);
    expect(r.errors).toEqual([]);
  });

  it("falls back to BUILTIN_RITUALS when the dir is empty", () => {
    const r = loadRituals(dir);
    expect(r.specs).toEqual(BUILTIN_RITUALS);
  });

  it("loads valid ritual JSON files", () => {
    writeJson("a.json", { name: "custom.hourly", cadence: { kind: "hourly" }, action: "health_snapshot" });
    writeJson("b.json", { name: "custom.daily",  cadence: { kind: "daily", hourUTC: 12 }, action: "journal" });
    const r = loadRituals(dir);
    expect(r.errors).toEqual([]);
    expect(r.specs).toHaveLength(2);
    expect(r.specs.map((s) => s.name).sort()).toEqual(["custom.daily", "custom.hourly"]);
  });

  it("rejects unknown action names", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "hourly" }, action: "reboot_the_universe" });
    const r = loadRituals(dir);
    expect(r.specs).toEqual([]);
    expect(r.errors.some((e) => /unknown action/.test(e))).toBe(true);
  });

  it("rejects invalid cadence shapes", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "daily", hourUTC: 99 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors.some((e) => /hourUTC/.test(e))).toBe(true);
    writeJson("bad2.json", { name: "y", cadence: { kind: "weekly", hourUTC: 3 }, action: "reflect" });
    const r2 = loadRituals(dir);
    expect(r2.errors.some((e) => /weekdayUTC/.test(e))).toBe(true);
  });

  it("rejects duplicate ritual names within one dir", () => {
    writeJson("a.json", { name: "dup", cadence: { kind: "hourly" }, action: "health_snapshot" });
    writeJson("b.json", { name: "dup", cadence: { kind: "daily", hourUTC: 12 }, action: "journal" });
    const r = loadRituals(dir);
    expect(r.specs.map((s) => s.name)).toEqual(["dup"]);
    expect(r.errors.some((e) => /duplicate/.test(e))).toBe(true);
  });

  it("skips malformed JSON files with a helpful error", () => {
    writeFileSync(join(dir, "bad.json"), "{not: json,");
    writeJson("good.json", { name: "g", cadence: { kind: "hourly" }, action: "health_snapshot" });
    const r = loadRituals(dir);
    expect(r.specs.map((s) => s.name)).toEqual(["g"]);
    expect(r.errors.some((e) => /bad JSON/.test(e))).toBe(true);
  });

  it("accepts a valid weekly cadence", () => {
    writeJson("a.json", { name: "w", cadence: { kind: "weekly", weekdayUTC: 3, hourUTC: 12 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors).toEqual([]);
    expect(r.specs).toHaveLength(1);
  });

  it("rejects non-object ritual definitions", () => {
    writeFileSync(join(dir, "a.json"), JSON.stringify("just-a-string"));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ name: "" }));
    writeFileSync(join(dir, "c.json"), JSON.stringify({ name: "n" })); // no cadence
    writeFileSync(join(dir, "d.json"), JSON.stringify({ name: "n", cadence: {} })); // no action
    const r = loadRituals(dir);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects weekly.hourUTC out of range", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "weekly", weekdayUTC: 0, hourUTC: 99 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors.some((e) => /hourUTC/.test(e))).toBe(true);
  });

  it("rejects daily.minuteUTC out of range", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "daily", hourUTC: 9, minuteUTC: 99 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors.some((e) => /minuteUTC/.test(e))).toBe(true);
  });

  it("rejects unknown cadence.kind", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "yearly" }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors.some((e) => /unknown cadence.kind/.test(e))).toBe(true);
  });

  it("rejects 'every' cadence with non-positive ms", () => {
    writeJson("bad.json", { name: "x", cadence: { kind: "every", ms: 0 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.errors.some((e) => /positive ms/.test(e))).toBe(true);
  });

  it("accepts a valid 'every ms' cadence", () => {
    writeJson("a.json", { name: "x", cadence: { kind: "every", ms: 5000 }, action: "reflect" });
    const r = loadRituals(dir);
    expect(r.specs).toHaveLength(1);
  });

  it("loads alex-triage's rituals dir cleanly and includes the reflect ritual", () => {
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const alexRituals = join(repoRoot, "coworkers", "alex-triage", "role", "rituals");
    const r = loadRituals(alexRituals);
    expect(r.errors).toEqual([]);
    const reflect = r.specs.find((s) => s.action === "reflect");
    expect(reflect).toBeDefined();
    expect(reflect!.cadence).toMatchObject({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 });
  });
});
