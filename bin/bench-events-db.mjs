#!/usr/bin/env node
// AIC-75 — bench events.db under our current schema (single file, FTS5
// AFTER INSERT trigger via initEpisodic).
//
// The suspected concern from the NanoClaw ticket: with the tick loop
// writing continuously and an operator-side webhook/inbox also writing
// (or an external system pushing events), we might see meaningful lock
// contention that would justify splitting into inbound.db + outbound.db.
//
// This script measures:
//   1. serial inserts/sec       — baseline
//   2. batched inserts (in-txn) — best case
//   3. two writers via async     — the actual concern (Node process
//      running two "write loops" in parallel against the same db)
//
// Run:  node --experimental-strip-types --no-warnings bin/bench-events-db.mjs [N]
// N defaults to 5000.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEvents } from "../src/runtime/log.ts";
import { initEpisodic } from "../src/runtime/episodic.ts";

const N = Number(process.argv[2] ?? 5000);
const dir = mkdtempSync(join(tmpdir(), "bench-events-"));

function newDb() {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.db`);
  const db = openEvents(path);
  initEpisodic(db);
  return db;
}

function serial(n) {
  const db = newDb();
  const stmt = db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)");
  const t0 = performance.now();
  for (let i = 0; i < n; i++) stmt.run(new Date().toISOString(), "t", "action", "{}");
  const ms = performance.now() - t0;
  return { ms, ips: n / (ms / 1000) };
}

function batched(n) {
  const db = newDb();
  const stmt = db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)");
  const t0 = performance.now();
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) stmt.run(new Date().toISOString(), "t", "action", "{}");
  db.exec("COMMIT");
  const ms = performance.now() - t0;
  return { ms, ips: n / (ms / 1000) };
}

async function twoWriters(n) {
  const db = newDb();
  const stmt = db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)");
  const half = Math.floor(n / 2);
  const writer = async (kind) => {
    for (let i = 0; i < half; i++) {
      stmt.run(new Date().toISOString(), "t", kind, "{}");
      // Yield occasionally so both loops actually interleave.
      if (i % 100 === 0) await new Promise((r) => setImmediate(r));
    }
  };
  const t0 = performance.now();
  await Promise.all([writer("tickA"), writer("tickB")]);
  const ms = performance.now() - t0;
  return { ms, ips: (half * 2) / (ms / 1000) };
}

try {
  console.log(`bench: N=${N} events, schema=current (FTS5 trigger enabled)\n`);
  const s = serial(N);
  console.log(`serial      : ${s.ms.toFixed(0)}ms → ${s.ips.toFixed(0)} inserts/sec`);
  const b = batched(N);
  console.log(`batched     : ${b.ms.toFixed(0)}ms → ${b.ips.toFixed(0)} inserts/sec (${(b.ips / s.ips).toFixed(1)}× serial)`);
  const w = await twoWriters(N);
  console.log(`two-writer  : ${w.ms.toFixed(0)}ms → ${w.ips.toFixed(0)} inserts/sec (${(w.ips / s.ips).toFixed(2)}× serial)`);

  console.log(`
Interpretation:
- If two-writer throughput is close to serial (say > 0.7×), we're fine —
  the sync SQLite driver serialises callers in-process anyway. No
  contention to justify a schema split.
- If two-writer is < 0.5× serial AND we routinely see two writers,
  splitting into inbound.db (writes from external → tick) and events.db
  (writes from tick → self) would help.
- Batched result is only relevant to bulk-seed test setup (see the fix
  in test/tick.test.ts:113 for the 500-row example).
`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
