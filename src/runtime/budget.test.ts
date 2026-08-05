import { describe, it, expect, beforeEach } from "vitest";
import { extractCallCap, checkBudget } from "./budget.ts";
import { openEvents } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "budget-")); });

describe("extractCallCap", () => {
  it("returns default when missing", () => {
    expect(extractCallCap("no cap here")).toBe(5000);
  });
  it("parses the line", () => {
    expect(extractCallCap("- Max LLM calls per day: 200")).toBe(200);
  });
});

describe("checkBudget", () => {
  it("under-budget when few calls", () => {
    const db = openEvents(join(dir, "e.db"));
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
        .run(new Date().toISOString(), "t", "deliberate", "{}");
    }
    const g = checkBudget(db, 100, now);
    expect(g.callsToday).toBe(3);
    expect(g.overBudget).toBe(false);
    expect(g.minutesUntilReset).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("over-budget when at cap", () => {
    const db = openEvents(join(dir, "e.db"));
    for (let i = 0; i < 5; i++)
      db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
        .run(new Date().toISOString(), "t", "deliberate.error", "{}");
    const g = checkBudget(db, 5);
    expect(g.overBudget).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("only counts today's calls", () => {
    const db = openEvents(join(dir, "e.db"));
    const yesterday = new Date(Date.now() - 25 * 3600_000).toISOString();
    db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(yesterday, "t", "deliberate", "{}");
    const g = checkBudget(db, 100);
    expect(g.callsToday).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
