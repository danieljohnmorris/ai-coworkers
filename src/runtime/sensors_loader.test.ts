import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadSensors, isValidSummarise } from "./sensors_loader.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sensors-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (obj: unknown): void => {
  writeFileSync(join(dir, "SENSORS.json"), JSON.stringify(obj));
};

describe("loadSensors", () => {
  it("returns empty specs when file is missing", () => {
    const r = loadSensors(dir);
    expect(r).toEqual({ specs: [], errors: [], warnings: [] });
  });

  it("returns error on bad JSON", () => {
    writeFileSync(join(dir, "SENSORS.json"), "{not json");
    const r = loadSensors(dir);
    expect(r.specs).toEqual([]);
    expect(r.errors[0]).toMatch(/bad JSON/);
  });

  it("rejects non-array top level", () => {
    write({ foo: "bar" });
    const r = loadSensors(dir);
    expect(r.errors[0]).toMatch(/must be an array/);
  });

  it("loads valid specs", () => {
    write([
      { name: "gh.prs", mcp: "github", tool: "list_pulls", args: { state: "open" }, cacheMs: 60000, summarise: "count" },
      { name: "gh.issues", mcp: "github", tool: "list_issues" },
    ]);
    const r = loadSensors(dir);
    expect(r.errors).toEqual([]);
    expect(r.specs).toHaveLength(2);
    expect(r.specs[0].summarise).toBe("count");
    expect(r.specs[1].args).toBeUndefined();
  });

  it("rejects missing name/mcp/tool", () => {
    write([{ mcp: "x", tool: "y" }]);
    expect(loadSensors(dir).errors[0]).toMatch(/'name'/);
    write([{ name: "n", tool: "y" }]);
    expect(loadSensors(dir).errors[0]).toMatch(/'mcp'/);
    write([{ name: "n", mcp: "m" }]);
    expect(loadSensors(dir).errors[0]).toMatch(/'tool'/);
  });

  it("rejects non-object args", () => {
    write([{ name: "n", mcp: "m", tool: "t", args: [1, 2] }]);
    expect(loadSensors(dir).errors[0]).toMatch(/'args'/);
  });

  it("rejects negative/non-integer cacheMs", () => {
    write([{ name: "n", mcp: "m", tool: "t", cacheMs: -1 }]);
    expect(loadSensors(dir).errors[0]).toMatch(/cacheMs/);
    write([{ name: "n", mcp: "m", tool: "t", cacheMs: 1.5 }]);
    expect(loadSensors(dir).errors[0]).toMatch(/cacheMs/);
  });

  it("rejects invalid summarise", () => {
    write([{ name: "n", mcp: "m", tool: "t", summarise: "" }]);
    expect(loadSensors(dir).errors[0]).toMatch(/summarise/);
    write([{ name: "n", mcp: "m", tool: "t", summarise: ".bad" }]);
    expect(loadSensors(dir).errors[0]).toMatch(/summarise/);
    write([{ name: "n", mcp: "m", tool: "t", summarise: 5 }]);
    expect(loadSensors(dir).errors[0]).toMatch(/summarise/);
  });

  it("accepts each summarise form", () => {
    expect(isValidSummarise("identity")).toBe(true);
    expect(isValidSummarise("count")).toBe(true);
    expect(isValidSummarise("first")).toBe(true);
    expect(isValidSummarise("data.issues.items")).toBe(true);
    expect(isValidSummarise("")).toBe(false);
    expect(isValidSummarise("a..b")).toBe(false);
  });

  it("rejects non-object entries", () => {
    write(["nope"]);
    expect(loadSensors(dir).errors[0]).toMatch(/not an object/);
  });

  it("rejects duplicate names", () => {
    write([
      { name: "dup", mcp: "m", tool: "t" },
      { name: "dup", mcp: "m", tool: "t2" },
    ]);
    const r = loadSensors(dir);
    expect(r.specs).toHaveLength(1);
    expect(r.errors[0]).toMatch(/duplicate/);
  });
});
