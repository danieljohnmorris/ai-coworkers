// Resource ledger + cleanup sweep.
// Every side-effect a coworker creates (git worktree, cached clone, subprocess,
// scratch dir, drafted Google Doc, open Slack thread) is registered here.
// The sweep enforces per-coworker caps from BOUNDARIES.md and reaps abandoned
// resources so the machine stays clean across long runs.

import { DatabaseSync } from "node:sqlite";
import { rmSync, statSync, existsSync } from "node:fs";
import type { Log } from "./log.ts";
import type { ResourceLimits } from "./role.ts";

export type ResourceKind =
  | "worktree" | "clone" | "branch"
  | "subprocess"
  | "scratch_dir"
  | "gdoc_draft" | "slack_thread";

export function openHygiene(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      handle TEXT NOT NULL,           -- path, pid, url, thread ts
      opened_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL             -- active | idle | completed | reaped
    );
    CREATE INDEX IF NOT EXISTS ix_resources_status ON resources(status);
  `);
  return db;
}

export interface Resource {
  id: number;
  kind: ResourceKind;
  handle: string;
  opened_at: string;
  last_used_at: string;
  task_id: string | null;
  status: "active" | "idle" | "completed" | "reaped";
}

export function register(
  db: DatabaseSync,
  kind: ResourceKind,
  handle: string,
  taskId: string | null
): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO resources (kind, handle, opened_at, last_used_at, task_id, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    )
    .run(kind, handle, now, now, taskId);
  return Number(info.lastInsertRowid);
}

export function touch(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE resources SET last_used_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function markStatus(
  db: DatabaseSync,
  id: number,
  status: Resource["status"]
): void {
  db.prepare(`UPDATE resources SET status = ? WHERE id = ?`).run(status, id);
}

export function activeCount(db: DatabaseSync, kind: ResourceKind): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM resources WHERE kind = ? AND status IN ('active','idle')`)
    .get(kind) as { n: number };
  return row.n;
}

export function sweep(db: DatabaseSync, limits: ResourceLimits, log: Log): void {
  const now = Date.now();
  const maxAgeMs = limits.maxWorktreeAgeHours * 3600_000;
  const maxIdleMs = limits.killSubprocessIdleMin * 60_000;

  const active = db
    .prepare(`SELECT * FROM resources WHERE status IN ('active','idle')`)
    .all() as Resource[];

  let reaped = 0;

  for (const r of active) {
    const openedMs = Date.parse(r.opened_at);
    const idleMs = now - Date.parse(r.last_used_at);

    // Worktrees / clones: enforce max age
    if ((r.kind === "worktree" || r.kind === "scratch_dir") && now - openedMs > maxAgeMs) {
      reapPath(r.handle);
      markStatus(db, r.id, "reaped");
      log.event("hygiene.reap", { id: r.id, kind: r.kind, reason: "age", handle: r.handle });
      reaped++;
      continue;
    }

    // Subprocesses: kill if idle too long or already dead
    if (r.kind === "subprocess") {
      const pid = Number(r.handle);
      if (!isProcessAlive(pid)) {
        markStatus(db, r.id, "completed");
        continue;
      }
      if (idleMs > maxIdleMs) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        markStatus(db, r.id, "reaped");
        log.event("hygiene.reap", { id: r.id, kind: r.kind, reason: "idle", pid });
        reaped++;
      }
    }
  }

  // Enforce max worktree count: keep the newest N.
  const wts = db
    .prepare(
      `SELECT * FROM resources WHERE kind = 'worktree' AND status IN ('active','idle')
       ORDER BY opened_at ASC`
    )
    .all() as Resource[];
  const excess = wts.length - limits.maxWorktrees;
  for (let i = 0; i < excess; i++) {
    const r = wts[i];
    reapPath(r.handle);
    markStatus(db, r.id, "reaped");
    log.event("hygiene.reap", { id: r.id, kind: r.kind, reason: "over_cap" });
    reaped++;
  }

  log.event("hygiene.sweep", { reaped, active: active.length });
}

function reapPath(p: string): void {
  try {
    if (existsSync(p) && statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  } catch {
    // swallow; sweep is best-effort
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
