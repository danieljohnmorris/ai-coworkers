import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderMetrics } from "./metrics.ts";
import { openEvents } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let events: ReturnType<typeof openEvents>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-"));
  events = openEvents(join(dir, "e.db"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function insert(kind: string, payload: unknown, ts?: string): void {
  events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
    .run(ts ?? new Date().toISOString(), "t", kind, JSON.stringify(payload));
}

describe("renderMetrics", () => {
  it("emits Prometheus HELP + TYPE headers per metric", () => {
    insert("tick.start", {});
    const out = renderMetrics(events, "alex");
    expect(out).toMatch(/^# HELP aicoworker_events_last_hour/m);
    expect(out).toMatch(/^# TYPE aicoworker_events_last_hour gauge/m);
    expect(out).toMatch(/^aicoworker_events_last_hour\{coworker="alex",kind="tick.start"\} 1/m);
  });

  it("splits per-tool action counts", () => {
    insert("action", { tool: "linear.comment", input: {} });
    insert("action", { tool: "linear.comment", input: {} });
    insert("action", { tool: "slack.post", input: {} });
    const out = renderMetrics(events, "alex");
    expect(out).toMatch(/aicoworker_actions_by_tool_last_day\{coworker="alex",tool="linear.comment"\} 2/);
    expect(out).toMatch(/aicoworker_actions_by_tool_last_day\{coworker="alex",tool="slack.post"\} 1/);
  });

  it("sums token usage across deliberate events", () => {
    insert("deliberate", { prompt_tokens: 100, completion_tokens: 40 });
    insert("deliberate", { prompt_tokens: 250, completion_tokens: 30 });
    insert("deliberate", { prompt_tokens: null }); // missing usage — silently skipped
    const out = renderMetrics(events, "alex");
    expect(out).toContain(`aicoworker_prompt_tokens_last_day{coworker="alex"} 350`);
    expect(out).toContain(`aicoworker_completion_tokens_last_day{coworker="alex"} 70`);
    expect(out).toContain(`aicoworker_deliberate_calls_last_day{coworker="alex"} 3`);
  });

  it("emits last-tick timestamp for staleness alerts", () => {
    insert("tick.end", { duration_ms: 12 }, "2026-08-06T10:00:00.000Z");
    const out = renderMetrics(events, "alex");
    const expected = Math.floor(Date.parse("2026-08-06T10:00:00.000Z") / 1000);
    expect(out).toContain(`aicoworker_last_tick_timestamp_seconds{coworker="alex"} ${expected}`);
  });

  it("escapes special characters in label values", () => {
    // A coworker name with a double quote would break the label without escaping.
    insert("tick.start", {});
    const out = renderMetrics(events, 'weird"name');
    expect(out).toContain('coworker="weird\\"name"');
  });

  it("skips action events where payload.tool is not a string", () => {
    insert("action", { tool: 42 });               // non-string tool → skipped
    insert("action", { notTool: "x" });           // missing tool → skipped
    insert("action", "not-json-object-string");   // JSON.parse yields a string → skipped
    const out = renderMetrics(events, "alex");
    expect(out).not.toMatch(/aicoworker_actions_by_tool_last_day.*tool=/);
  });

  it("total events counter reflects the whole table", () => {
    for (let i = 0; i < 7; i++) insert("action", { tool: "x" });
    const out = renderMetrics(events, "alex");
    expect(out).toContain(`aicoworker_events_total{coworker="alex"} 7`);
  });
});
