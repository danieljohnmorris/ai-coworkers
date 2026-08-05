// Extra hygiene tests: subprocess reaping (alive vs dead vs idle-too-long).

import { describe, it, expect, beforeEach } from "vitest";
import { openHygiene, register, sweep, activeCount } from "./hygiene.ts";
import { openEvents, Log } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hys-")); });

describe("hygiene.sweep subprocess handling", () => {
  it("marks a dead pid as completed", () => {
    const db = openHygiene(join(dir, "h.db"));
    const events = openEvents(join(dir, "e.db"));
    const log = new Log(events, "t");
    // Very high pid unlikely to exist
    register(db, "subprocess", "9999999", null);
    sweep(db, { maxWorktrees: 10, maxWorktreeAgeHours: 24, maxDiskMB: 5120, killSubprocessIdleMin: 30 }, log);
    // Should transition to completed or reaped (no longer active)
    expect(activeCount(db, "subprocess")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
