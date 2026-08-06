// AIC-67 — Prometheus text-format metrics from events.db. Exposed on the
// wake server at GET /metrics when METRICS_ENABLED=1. Zero external deps
// (no prom-client, no OpenTelemetry SDK) — the text format is small
// enough to write by hand, and matches what Prometheus/Grafana Cloud/
// VictoriaMetrics scrape out of the box.
//
// Metric naming follows Prometheus conventions:
//   - snake_case
//   - suffix `_total` on monotonically-increasing counters
//   - suffix `_seconds` / `_bytes` on gauges of natural units
//   - namespace prefix `aicoworker_`
//
// Values aggregate from events.db over a rolling window (last hour +
// last day). Cheap to serve because everything is one SQL query per
// metric with the ts index. Do not call more than once per scrape
// interval (usually 15s) — Prometheus handles the sampling.

import type { DatabaseSync } from "node:sqlite";

export function renderMetrics(events: DatabaseSync, coworker: string): string {
  const lines: string[] = [];
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86400_000).toISOString();

  const countByKindSince = (since: string): Record<string, number> => {
    const rows = events.prepare(
      "SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind"
    ).all(since) as { kind: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  };

  const hour = countByKindSince(hourAgo);
  const day = countByKindSince(dayAgo);

  // Per-kind counters (windowed as gauges — a scraper computes rates itself).
  header(lines, "aicoworker_events_last_hour", "gauge", "Events by kind in the last hour");
  for (const [k, v] of Object.entries(hour)) {
    lines.push(`aicoworker_events_last_hour{coworker="${escLabel(coworker)}",kind="${escLabel(k)}"} ${v}`);
  }
  header(lines, "aicoworker_events_last_day", "gauge", "Events by kind in the last 24h");
  for (const [k, v] of Object.entries(day)) {
    lines.push(`aicoworker_events_last_day{coworker="${escLabel(coworker)}",kind="${escLabel(k)}"} ${v}`);
  }

  // Per-tool action count over 24h — useful for "which tools does this
  // coworker actually reach for?" dashboards.
  const perTool = events.prepare(
    "SELECT payload FROM events WHERE kind = 'action' AND ts >= ?"
  ).all(dayAgo) as { payload: string }[];
  const toolCounts: Record<string, number> = {};
  for (const r of perTool) {
    try {
      const t = JSON.parse(r.payload).tool;
      if (typeof t === "string") toolCounts[t] = (toolCounts[t] ?? 0) + 1;
    } catch { /* skip malformed */ }
  }
  header(lines, "aicoworker_actions_by_tool_last_day", "gauge", "Actions per tool over the last 24h");
  for (const [t, n] of Object.entries(toolCounts)) {
    lines.push(`aicoworker_actions_by_tool_last_day{coworker="${escLabel(coworker)}",tool="${escLabel(t)}"} ${n}`);
  }

  // Token usage — deliberate events carry prompt_tokens + completion_tokens.
  const usage = events.prepare(
    "SELECT payload FROM events WHERE kind = 'deliberate' AND ts >= ?"
  ).all(dayAgo) as { payload: string }[];
  let promptTokens = 0, completionTokens = 0, deliberateCalls = 0;
  for (const r of usage) {
    try {
      const p = JSON.parse(r.payload);
      if (typeof p.prompt_tokens === "number") promptTokens += p.prompt_tokens;
      if (typeof p.completion_tokens === "number") completionTokens += p.completion_tokens;
      deliberateCalls++;
    } catch { /* skip */ }
  }
  header(lines, "aicoworker_prompt_tokens_last_day", "gauge", "Prompt tokens over the last 24h");
  lines.push(`aicoworker_prompt_tokens_last_day{coworker="${escLabel(coworker)}"} ${promptTokens}`);
  header(lines, "aicoworker_completion_tokens_last_day", "gauge", "Completion tokens over the last 24h");
  lines.push(`aicoworker_completion_tokens_last_day{coworker="${escLabel(coworker)}"} ${completionTokens}`);
  header(lines, "aicoworker_deliberate_calls_last_day", "gauge", "Deliberate LLM calls over the last 24h");
  lines.push(`aicoworker_deliberate_calls_last_day{coworker="${escLabel(coworker)}"} ${deliberateCalls}`);

  // Total-events-ever, useful as an "am I still alive and writing" heartbeat.
  const totalRow = events.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  header(lines, "aicoworker_events_total", "counter", "All events ever recorded");
  lines.push(`aicoworker_events_total{coworker="${escLabel(coworker)}"} ${totalRow.n}`);

  // Last-tick timestamp — Prometheus can alert on staleness.
  const lastTick = events.prepare(
    "SELECT ts FROM events WHERE kind = 'tick.end' ORDER BY id DESC LIMIT 1"
  ).get() as { ts: string } | undefined;
  if (lastTick) {
    header(lines, "aicoworker_last_tick_timestamp_seconds", "gauge", "Unix time of the most recent tick.end");
    lines.push(`aicoworker_last_tick_timestamp_seconds{coworker="${escLabel(coworker)}"} ${Math.floor(Date.parse(lastTick.ts) / 1000)}`);
  }

  return lines.join("\n") + "\n";
}

function header(out: string[], name: string, type: "counter" | "gauge" | "histogram", help: string): void {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
}

// Escape a label value per Prometheus text format: backslash, double
// quote, newline.
function escLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
