// Fleet status dashboard. Reads events.db for every coworker in coworkers/
// and serves a single HTML page + JSON API on localhost:7777.
//
// Run:
//   node --experimental-strip-types --no-warnings src/dashboard.ts

import { createServer } from "node:http";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.DASHBOARD_PORT ?? 7777);
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const COWORKERS_DIR = join(REPO_ROOT, "coworkers");

interface CoworkerStatus {
  name: string;
  lastTick: string | null;
  lastAction: string | null;
  actionsLast24h: number;
  errorsLast24h: number;
  callsToday: number;
  boundaryBlocksToday: number;
}

function listCoworkers(): string[] {
  if (!existsSync(COWORKERS_DIR)) return [];
  return readdirSync(COWORKERS_DIR).filter((f) => {
    const p = join(COWORKERS_DIR, f);
    return statSync(p).isDirectory() && existsSync(join(p, "state", "events.db"));
  });
}

function statusOf(name: string): CoworkerStatus {
  const db = new DatabaseSync(join(COWORKERS_DIR, name, "state", "events.db"));
  const one = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as any;
  const lastTick = one(`SELECT ts FROM events WHERE kind='tick.end' ORDER BY id DESC LIMIT 1`)?.ts ?? null;
  const lastAction = one(`SELECT ts FROM events WHERE kind='action' ORDER BY id DESC LIMIT 1`)?.ts ?? null;
  const dayCut = new Date(Date.now() - 86400_000).toISOString();
  const utcMidnight = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())).toISOString();
  return {
    name,
    lastTick,
    lastAction,
    actionsLast24h: one(`SELECT COUNT(*) AS n FROM events WHERE kind='action' AND ts >= ?`, dayCut).n,
    errorsLast24h: one(`SELECT COUNT(*) AS n FROM events WHERE kind LIKE '%.error' AND ts >= ?`, dayCut).n,
    callsToday: one(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('deliberate','deliberate.error') AND ts >= ?`, utcMidnight).n,
    boundaryBlocksToday: one(`SELECT COUNT(*) AS n FROM events WHERE kind='boundary.block' AND ts >= ?`, utcMidnight).n,
  };
}

function renderHtml(rows: CoworkerStatus[]): string {
  const items = rows.map((r) => `
    <tr>
      <td><b>${r.name}</b></td>
      <td>${r.lastTick ?? "—"}</td>
      <td>${r.lastAction ?? "—"}</td>
      <td>${r.actionsLast24h}</td>
      <td>${r.errorsLast24h}</td>
      <td>${r.callsToday}</td>
      <td>${r.boundaryBlocksToday}</td>
    </tr>`).join("");
  return `<!doctype html>
<html><head><title>ai-coworkers fleet</title>
<meta http-equiv="refresh" content="15">
<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:1100px;margin:auto}
table{border-collapse:collapse;width:100%}
th,td{padding:.5rem .75rem;border-bottom:1px solid #ddd;text-align:left;font-size:.9rem}
th{background:#f5f5f5}code{background:#f0f0f0;padding:.1rem .3rem;border-radius:3px}</style>
</head><body>
<h1>ai-coworkers fleet</h1>
<p>Auto-refresh every 15s. Live from each coworker's <code>events.db</code>.</p>
<table><thead><tr>
<th>coworker</th><th>last tick</th><th>last action</th>
<th>actions/24h</th><th>errors/24h</th><th>calls today</th><th>boundary blocks</th>
</tr></thead><tbody>${items || '<tr><td colspan=7>no coworkers with state yet</td></tr>'}</tbody></table>
</body></html>`;
}

const server = createServer((req, res) => {
  const rows = listCoworkers().map(statusOf);
  if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows, null, 2));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderHtml(rows));
});
server.listen(PORT, () => {
  process.stdout.write(`dashboard: http://localhost:${PORT}\n`);
});
