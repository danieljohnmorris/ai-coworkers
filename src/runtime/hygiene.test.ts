import { describe, it, expect, beforeEach } from "vitest";
import { openHygiene, register, touch, markStatus, activeCount, sweep } from "./hygiene.ts";
import { openEvents, Log } from "./log.ts";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hy-")); });

describe("hygiene ledger", () => {
  it("registers and counts by kind", () => {
    const db = openHygiene(join(dir, "h.db"));
    const id = register(db, "worktree", "/tmp/x", "task-1");
    expect(id).toBeGreaterThan(0);
    expect(activeCount(db, "worktree")).toBe(1);
    expect(activeCount(db, "subprocess")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("touch updates last_used_at", () => {
    const db = openHygiene(join(dir, "h.db"));
    const id = register(db, "worktree", "/tmp/x", null);
    touch(db, id);
    const row = db.prepare("SELECT last_used_at FROM resources WHERE id = ?").get(id) as any;
    expect(row.last_used_at).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sweep reaps over-cap worktrees on disk", () => {
    const db = openHygiene(join(dir, "h.db"));
    const events = openEvents(join(dir, "e.db"));
    const log = new Log(events, "t");
    const wt = join(dir, "wt");
    mkdirSync(wt);
    register(db, "worktree", wt, null);
    // Cap = 0 → reap the one we have
    sweep(db, { maxWorktrees: 0, maxWorktreeAgeHours: 24, maxDiskMB: 5120, killSubprocessIdleMin: 30 }, log);
    expect(existsSync(wt)).toBe(false);
    const status = (db.prepare("SELECT status FROM resources").get() as any).status;
    expect(status).toBe("reaped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("markStatus writes status", () => {
    const db = openHygiene(join(dir, "h.db"));
    const id = register(db, "subprocess", "999999", null);
    markStatus(db, id, "completed");
    const row = db.prepare("SELECT status FROM resources WHERE id = ?").get(id) as any;
    expect(row.status).toBe("completed");
    rmSync(dir, { recursive: true, force: true });
  });
});
