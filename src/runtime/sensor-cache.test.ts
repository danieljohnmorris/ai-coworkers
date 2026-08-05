import { describe, it, expect } from "vitest";
import { getCached, setCached, minInterval } from "./sensor-cache.ts";

describe("sensor-cache", () => {
  it("has known TTLs for known prefixes", () => {
    expect(minInterval("linear.new_issues")).toBe(5 * 60_000);
    expect(minInterval("slack.mentions")).toBe(60_000);
    expect(minInterval("github.pulls")).toBe(5 * 60_000);
    expect(minInterval("gmail.inbox")).toBe(5 * 60_000);
    expect(minInterval("gdocs.recent")).toBe(10 * 60_000);
  });

  it("returns 0 (never-cache) for unknown prefixes", () => {
    expect(minInterval("self.tempo")).toBe(0);
    expect(minInterval("clock")).toBe(0);
  });

  it("caches within TTL and expires after", () => {
    const key = "linear.new_issues";
    setCached(key, ["a"], 1_000_000);
    expect(getCached(key, 1_000_000 + 60_000)).toEqual(["a"]);
    expect(getCached(key, 1_000_000 + 5 * 60_000 + 1)).toBeUndefined();
  });

  it("never returns cached values for zero-TTL sensors", () => {
    setCached("clock.now", "12:00", 1_000_000);
    expect(getCached("clock.now", 1_000_000 + 10)).toBeUndefined();
  });
});
