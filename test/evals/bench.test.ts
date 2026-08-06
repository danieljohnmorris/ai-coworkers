import { describe, it, expect } from "vitest";
// The bench harness lives as a .mjs script so it can be invoked
// directly. We import score() to unit-test the rubric independently
// of the CLI wrapper — a real coworker's responses will get scored
// through the same function once wired.
import { score } from "./bench.mjs";

const scenario = {
  name: "test-scenario",
  role: "watchtower",
  prompt: "…",
  sensors: [],
  expected_root_cause: "connection pool size bump multiplied per-pod * pod count → hit RDS max_connections ceiling",
  required_evidence: ["abc123", "1180", "1200"],
  red_herrings: ["upgrade RDS instance size", "restart pods"],
};

describe("score()", () => {
  it("gives 1.0 to a perfect response that repeats root cause + all evidence", () => {
    const r = score({
      reason: scenario.expected_root_cause,
      thoughts: "noticed abc123, 1180, 1200",
      input: {},
    }, scenario);
    expect(r.total).toBeCloseTo(1.0, 2);
    expect(r.rootCauseMatch).toBeCloseTo(1.0, 2);
    expect(r.evidenceCoverage).toBe(1);
    expect(r.redHerringAvoidance).toBe(1);
  });

  it("partial evidence coverage lowers total but doesn't zero it", () => {
    const r = score({
      reason: scenario.expected_root_cause,
      thoughts: "saw abc123 only",
      input: {},
    }, scenario);
    // 1 of 3 evidence tokens → evidenceCoverage = 1/3 ≈ 0.33
    expect(r.evidenceCoverage).toBeCloseTo(0.333, 2);
    // Still gets full root_cause + red_herring — total between 0.4 and 1.0
    expect(r.total).toBeGreaterThan(0.4);
    expect(r.total).toBeLessThan(1.0);
  });

  it("penalises red herrings", () => {
    const withHerring = score({
      reason: scenario.expected_root_cause,
      thoughts: "let's restart pods first",
      input: { action: "restart pods" },
    }, scenario);
    // 'restart pods' appears in both thoughts and input.action — but the
    // scorer counts unique red_herrings matched, not occurrences.
    // 1 of 2 red_herrings matched → avoidance = 1 - 0.5 = 0.5
    expect(withHerring.redHerringAvoidance).toBe(0.5);
    expect(withHerring.hits.red_herring).toBe(1);
  });

  it("floors red-herring penalty at 0 (multiple hits don't push negative)", () => {
    const disaster = score({
      reason: "let's upgrade RDS instance size AND restart pods",
      thoughts: "and roll back a different deploy",
      input: {},
    }, scenario);
    expect(disaster.redHerringAvoidance).toBeGreaterThanOrEqual(0);
  });

  it("root-cause match uses word-token overlap not exact string", () => {
    const paraphrased = score({
      reason: "pool bump multiplied per-pod times pod count meant max_connections ceiling was hit",
      thoughts: "abc123, 1180, 1200 all lined up",
      input: {},
    }, scenario);
    // Different word order, same content → high but not necessarily 1.0
    expect(paraphrased.rootCauseMatch).toBeGreaterThan(0.4);
  });
});
