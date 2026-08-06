import { describe, it, expect, beforeEach } from "vitest";
import { isDue, lastRun, markRun, runDue } from "./rituals.ts";
import { openEvents } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rit-")); });

describe("isDue", () => {
  it("hourly: never-run is due", () => {
    expect(isDue({ kind: "hourly" }, null, new Date())).toBe(true);
  });

  it("hourly: due after 1h", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const last = new Date("2026-01-01T10:59:00Z");
    expect(isDue({ kind: "hourly" }, last, now)).toBe(true);
  });

  it("hourly: not due within 1h", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const last = new Date("2026-01-01T11:30:00Z");
    expect(isDue({ kind: "hourly" }, last, now)).toBe(false);
  });

  it("every: due after exact interval", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(isDue({ kind: "every", ms: 60_000 }, new Date(now.getTime() - 60_000), now)).toBe(true);
    expect(isDue({ kind: "every", ms: 60_000 }, new Date(now.getTime() - 30_000), now)).toBe(false);
  });

  it("daily: due after scheduled hour, once per day", () => {
    const now = new Date("2026-01-01T09:30:00Z");
    expect(isDue({ kind: "daily", hourUTC: 9 }, null, now)).toBe(true);
    expect(isDue({ kind: "daily", hourUTC: 10 }, null, now)).toBe(false);
    // Ran already this morning at 09:01 → not due at 09:30
    const ranToday = new Date("2026-01-01T09:01:00Z");
    expect(isDue({ kind: "daily", hourUTC: 9 }, ranToday, now)).toBe(false);
  });

  it("weekly: due only on the right weekday", () => {
    const sun = new Date("2026-01-04T03:00:00Z"); // Sunday
    const mon = new Date("2026-01-05T03:00:00Z");
    expect(isDue({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, null, sun)).toBe(true);
    expect(isDue({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, null, mon)).toBe(false);
  });

  it("weekly: not due before scheduled hour; due again 24h+ after last run", () => {
    const sunEarly = new Date("2026-01-04T02:00:00Z");
    const sunLate = new Date("2026-01-04T03:30:00Z");
    // Before the scheduled hour → not due.
    expect(isDue({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, null, sunEarly)).toBe(false);
    // After scheduled hour with a recent run (<24h ago) → not due.
    const recent = new Date("2026-01-04T03:15:00Z");
    expect(isDue({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, recent, sunLate)).toBe(false);
    // After scheduled hour with the last run >24h ago → due.
    const wayBack = new Date("2025-12-28T03:00:00Z");
    expect(isDue({ kind: "weekly", weekdayUTC: 0, hourUTC: 3 }, wayBack, sunLate)).toBe(true);
  });
});

describe("lastRun / markRun", () => {
  it("returns null when never run", () => {
    const db = openEvents(join(dir, "e.db"));
    expect(lastRun(db, "x")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the most recent run", () => {
    const db = openEvents(join(dir, "e.db"));
    markRun(db, "reflect.weekly", "t");
    const l = lastRun(db, "reflect.weekly");
    expect(l).toBeInstanceOf(Date);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not confuse rituals with the same coworker but different names", () => {
    const db = openEvents(join(dir, "e.db"));
    markRun(db, "a", "t");
    expect(lastRun(db, "b")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runDue", () => {
  it("fires a due ritual and records it", async () => {
    const db = openEvents(join(dir, "e.db"));
    let fired = 0;
    const ritual = { name: "test", cadence: { kind: "hourly" as const }, run: async () => { fired++; } };
    const out = await runDue([ritual], db, "t");
    expect(fired).toBe(1);
    expect(out.length).toBe(1);
    expect(lastRun(db, "test")).toBeInstanceOf(Date);
    // Second immediate call: not due
    const again = await runDue([ritual], db, "t");
    expect(fired).toBe(1);
    expect(again.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records failure but still marks the ritual so we don't retry-storm", async () => {
    const db = openEvents(join(dir, "e.db"));
    const ritual = { name: "x", cadence: { kind: "hourly" as const }, run: async () => { throw new Error("boom"); } };
    const out = await runDue([ritual], db, "t");
    expect(out.length).toBe(1);
    expect(lastRun(db, "x")).toBeInstanceOf(Date);
    rmSync(dir, { recursive: true, force: true });
  });
});
