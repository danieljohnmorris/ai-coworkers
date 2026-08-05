import { describe, it, expect, beforeEach } from "vitest";
import { readTempo, readBudget, extractTempoGuidance } from "./tempo.ts";
import { openEvents } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempo-"));
});

function seedEvent(db: any, kind: string, offsetMs: number, payload: unknown) {
  const ts = new Date(Date.now() - offsetMs).toISOString();
  db.prepare(`INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)`)
    .run(ts, "t", kind, JSON.stringify(payload));
}

describe("readTempo", () => {
  it("counts actions in the last hour and day", () => {
    const db = openEvents(join(dir, "e.db"));
    seedEvent(db, "action", 60_000, {});               // 1 min ago
    seedEvent(db, "action", 30 * 60_000, {});          // 30 min ago
    seedEvent(db, "action", 2 * 3600_000, {});         // 2 h ago
    seedEvent(db, "action", 25 * 3600_000, {});        // 25 h ago
    const t = readTempo(db);
    expect(t.actionsLast1h).toBe(2);
    expect(t.actionsLast24h).toBe(3);
    expect(t.secondsSinceLastAction).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("computes noop ratio from last 100 deliberate events", () => {
    const db = openEvents(join(dir, "e.db"));
    for (let i = 0; i < 8; i++) seedEvent(db, "deliberate", 1000 * i, { choice: "noop" });
    for (let i = 0; i < 2; i++) seedEvent(db, "deliberate", 100_000 + 1000 * i, { choice: "call" });
    const t = readTempo(db);
    expect(t.noopRatioLast100Ticks).toBeCloseTo(0.8, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for secondsSinceLastAction when no actions", () => {
    const db = openEvents(join(dir, "e.db"));
    seedEvent(db, "deliberate", 1000, { choice: "noop" });
    const t = readTempo(db);
    expect(t.secondsSinceLastAction).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readBudget", () => {
  it("counts LLM calls and errors in last 24h", () => {
    const db = openEvents(join(dir, "e.db"));
    for (let i = 0; i < 5; i++) seedEvent(db, "deliberate", 1000 * i, {});
    seedEvent(db, "deliberate.error", 2000, { error: "x" });
    seedEvent(db, "deliberate", 25 * 3600_000, {}); // outside window
    const b = readBudget(db);
    expect(b.llmCallsToday).toBe(6);
    expect(b.deliberateErrorsToday).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("extractTempoGuidance", () => {
  it("returns empty string when no Tempo section", () => {
    expect(extractTempoGuidance("just some rituals")).toBe("");
  });

  it("extracts a Tempo section until the next heading", () => {
    const md = [
      "## Rituals",
      "- daily standup",
      "",
      "## Tempo",
      "- at most 4/hr",
      "- noop ratio > 0.8",
      "",
      "## Something else",
      "- unrelated",
    ].join("\n");
    const out = extractTempoGuidance(md);
    expect(out).toContain("## Tempo");
    expect(out).toContain("at most 4/hr");
    expect(out).not.toContain("Something else");
  });
});
