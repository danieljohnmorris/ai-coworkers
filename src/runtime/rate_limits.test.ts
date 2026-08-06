import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRateLimit, rateLimitRemaining, activeRateLimits,
  retryAfterFrom, _resetRateLimitsForTests,
} from "./rate_limits.ts";

beforeEach(() => _resetRateLimitsForTests());

describe("rate_limits", () => {
  it("records + reports remaining seconds for the affected prefix", () => {
    recordRateLimit("linear.new_issues", 30, "429");
    expect(rateLimitRemaining("linear.new_issues")).toBeGreaterThanOrEqual(29);
    expect(rateLimitRemaining("linear.anything.else")).toBeGreaterThanOrEqual(29);
    // A different prefix is not affected.
    expect(rateLimitRemaining("slack.mentions")).toBe(0);
  });

  it("clamps ridiculous Retry-After values (both directions)", () => {
    recordRateLimit("linear.x", 1);        // clamped to floor of 5
    expect(rateLimitRemaining("linear.x")).toBeGreaterThanOrEqual(4);
    _resetRateLimitsForTests();
    recordRateLimit("linear.x", 10_000);   // clamped to ceiling of 3600
    expect(rateLimitRemaining("linear.x")).toBeLessThanOrEqual(3600);
  });

  it("uses a 60s default when Retry-After isn't given", () => {
    recordRateLimit("linear.x");
    const remaining = rateLimitRemaining("linear.x");
    expect(remaining).toBeGreaterThanOrEqual(55);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it("garbage-collects expired entries lazily", () => {
    // Insert with a floor value, then jump forward via 'now' arg.
    recordRateLimit("linear.x", 5);
    const future = Date.now() + 10_000;
    expect(rateLimitRemaining("linear.x", future)).toBe(0);
    // ActiveRateLimits with the same 'now' also returns [].
    expect(activeRateLimits(future)).toEqual([]);
  });

  it("activeRateLimits reports current back-offs with ISO 'until'", () => {
    recordRateLimit("linear.x", 30, "429 from linear.new_issues");
    recordRateLimit("slack.y", 60, "429 from slack.mentions");
    const active = activeRateLimits();
    expect(active.map((a) => a.prefix).sort()).toEqual(["linear", "slack"]);
    for (const a of active) expect(a.untilIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("retryAfterFrom", () => {
  it("parses a numeric-seconds Retry-After header", () => {
    const h = new Headers({ "retry-after": "42" });
    expect(retryAfterFrom(h)).toBe(42);
  });

  it("parses an HTTP-date Retry-After header", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const h = new Headers({ "retry-after": future });
    const s = retryAfterFrom(h);
    expect(s).toBeGreaterThanOrEqual(25);
    expect(s).toBeLessThanOrEqual(31);
  });

  it("returns undefined when Retry-After is unparseable garbage", () => {
    const h = new Headers({ "retry-after": "not a date and not a number" });
    expect(retryAfterFrom(h)).toBeUndefined();
  });

  it("accepts a plain object header map", () => {
    expect(retryAfterFrom({ "retry-after": "17" })).toBe(17);
    expect(retryAfterFrom({ "Retry-After": "9" })).toBe(9);
    expect(retryAfterFrom({})).toBeUndefined();
  });

  it("returns undefined when header is missing", () => {
    expect(retryAfterFrom(new Headers())).toBeUndefined();
  });
});
