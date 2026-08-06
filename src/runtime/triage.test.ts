import { describe, it, expect, afterEach } from "vitest";
import { triage, summariseForTriage } from "./triage.ts";
import type { Perception } from "./deliberate.ts";
import type { LLMConfig } from "./llm.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const emptyPerception = (over: Partial<Perception> = {}): Perception => ({
  now: "2026-08-06T00:00:00.000Z",
  sensors: [], recentActions: [], pendingPromises: [], resources: [], rollups: [],
  tempo: { callsToday: 0, callsPerHour: 0, noopRatioLast100: 1, secondsSinceLastPerceptionChange: 0 },
  budget: { callsToday: 0, dailyCap: 500, callsInWindow: 0, windowCap: 200, windowMinutes: 300 },
  tempoGuidance: "", highlightsTail: "", recentThoughts: "", inboxUnread: "", reactionsUnread: "", rateLimits: [],
  ...over,
});

const llm: LLMConfig = { baseUrl: "http://fake", apiKey: "k", model: "cheap" };

describe("summariseForTriage", () => {
  it("compresses sensors into array-count bullets when possible", () => {
    const s = summariseForTriage(emptyPerception({
      sensors: [
        { name: "linear.new_issues", result: { issues: [1, 2, 3] } },
        { name: "slack.mentions", result: { mentions: [] } },
      ],
    }));
    expect(s).toContain("linear.new_issues: issues=3");
    expect(s).toContain("slack.mentions: mentions=0");
  });

  it("renders sensor with no array fields as key list", () => {
    const s = summariseForTriage(emptyPerception({
      sensors: [{ name: "s.no_arrays", result: { a: 1, b: 2, c: 3 } }],
    }));
    expect(s).toContain("s.no_arrays: a,b,c");
  });

  it("renders sensor error line", () => {
    const s = summariseForTriage(emptyPerception({
      sensors: [{ name: "s.err", result: null, error: "boom" }],
    }));
    expect(s).toContain("s.err: error(boom)");
  });

  it("renders sensor result that is not an object at all", () => {
    const s = summariseForTriage(emptyPerception({
      sensors: [{ name: "s.scalar", result: 42 }],
    }));
    expect(s).toContain("s.scalar: 42");
  });

  it("surfaces inbox + reactions when present", () => {
    const s = summariseForTriage(emptyPerception({
      inboxUnread: "please look at ILO-42",
      reactionsUnread: "- 👎 stop reopening",
    }));
    expect(s).toContain("Inbox unread");
    expect(s).toContain("Reactions unread");
  });
});

describe("triage", () => {
  it("returns act=false when the cheap model says skip", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"act":false,"reason":"backlog quiet"}' } }],
    }))) as typeof fetch;
    const r = await triage(llm, emptyPerception());
    expect(r.act).toBe(false);
    expect(r.reason).toBe("backlog quiet");
  });

  it("returns act=true when the cheap model says act", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"act":true,"reason":"3 untriaged"}' } }],
    }))) as typeof fetch;
    const r = await triage(llm, emptyPerception());
    expect(r.act).toBe(true);
  });

  it("biases to act=true on unparseable output", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "I don't know" } }],
    }))) as typeof fetch;
    const r = await triage(llm, emptyPerception());
    expect(r.act).toBe(true);
    expect(r.reason).toMatch(/unparseable/);
  });

  it("biases to act=true on network / auth error", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const r = await triage(llm, emptyPerception());
    expect(r.act).toBe(true);
    expect(r.reason).toMatch(/triage error/);
  });
});
