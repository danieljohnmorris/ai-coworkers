import { describe, it, expect, beforeEach } from "vitest";
import { shouldSkip, recordError, recordSuccess, _resetForTests } from "./circuit.ts";

beforeEach(() => _resetForTests());

describe("circuit breaker", () => {
  it("does not skip a healthy sensor", () => {
    expect(shouldSkip("linear.new_issues")).toBe(false);
  });

  it("trips after N consecutive errors", () => {
    const s = "sensor";
    for (let i = 0; i < 4; i++) expect(recordError(s).quarantined).toBe(false);
    expect(recordError(s).quarantined).toBe(true);
    expect(shouldSkip(s)).toBe(true);
  });

  it("recordSuccess resets the counter", () => {
    const s = "s";
    recordError(s); recordError(s); recordError(s);
    recordSuccess(s);
    expect(recordError(s).quarantined).toBe(false); // starts from zero again
  });

  it("un-skips after cooldown", () => {
    const s = "s";
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordError(s, now, 5, 1000);
    expect(shouldSkip(s, now + 500)).toBe(true);
    expect(shouldSkip(s, now + 2000)).toBe(false);
  });
});
