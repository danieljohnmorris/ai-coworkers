import { describe, it, expect, afterEach } from "vitest";
import { deliberate, parseDecision, type Perception } from "./deliberate.ts";
import type { LLMConfig } from "./llm.ts";

describe("parseDecision", () => {
  it("parses a bare JSON noop", () => {
    const r = parseDecision('{"action":"noop","reason":"quiet"}');
    expect(r.action).toBe("noop");
    if (r.action === "noop") expect(r.reason).toBe("quiet");
  });

  it("parses a bare JSON call", () => {
    const r = parseDecision(
      '{"action":"call","tool":"linear.comment","input":{"issueId":"X","body":"y"},"reason":"triage"}'
    );
    expect(r.action).toBe("call");
    if (r.action === "call") {
      expect(r.tool).toBe("linear.comment");
      expect(r.input).toEqual({ issueId: "X", body: "y" });
    }
  });

  it("strips a ```json fence", () => {
    const r = parseDecision('```json\n{"action":"noop","reason":"a"}\n```');
    expect(r.action).toBe("noop");
  });

  it("extracts the first {...} from surrounding prose", () => {
    const raw = 'Sure! Here it is:\n{"action":"noop","reason":"b"}\nHope that helps.';
    const r = parseDecision(raw);
    expect(r.action).toBe("noop");
  });

  it("handles nested braces in input correctly", () => {
    const raw = '{"action":"call","tool":"x.y","input":{"a":{"b":1},"c":"}"},"reason":"nested"}';
    const r = parseDecision(raw);
    expect(r.action).toBe("call");
    if (r.action === "call") expect((r.input as any).a.b).toBe(1);
  });

  it("accepts lenient form: action is tool name", () => {
    const r = parseDecision('{"action":"linear.comment","input":{"issueId":"X"},"reason":"r"}') as any;
    expect(r.action).toBe("call");
    expect(r.tool).toBe("linear.comment");
    expect(r.input.issueId).toBe("X");
  });

  it("accepts lenient form: tool + arguments", () => {
    const r = parseDecision('{"tool":"github.pr_comment","arguments":{"body":"hi"},"reason":"r"}') as any;
    expect(r.action).toBe("call");
    expect(r.tool).toBe("github.pr_comment");
    expect(r.input.body).toBe("hi");
  });

  it("returns noop + rawOutput on truly unparseable text", () => {
    const raw = "I refuse to output JSON, sorry.";
    const r = parseDecision(raw) as any;
    expect(r.action).toBe("noop");
    expect(r.reason).toMatch(/unparseable/);
    expect(r.rawOutput).toBe(raw);
  });
});

// AIC-56 — verify that a large prior-step outcome is compacted into the
// deliberate prompt rather than raw-truncated (losing the middle).
describe("deliberate — prompt compaction", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const role = {
    name: "t",
    dir: "/tmp/ignored",
    systemPrompt: "system",
    docs: { ROLE: "", RESPONSIBILITIES: "", AUTHORITY: "", BOUNDARIES: "", RITUALS: "", RELATIONSHIPS: "", TOOLS: "", WORKSPACE: "" },
    limits: { maxWorktrees: 0, maxWorktreeAgeHours: 24, maxDiskMB: 100, killSubprocessIdleMin: 30 },
    cadence: "adaptive" as const,
  };
  const perception: Perception = {
    now: "2026-08-06T00:00:00.000Z",
    sensors: [], recentActions: [], pendingPromises: [], resources: [], rollups: [],
    tempo: { callsToday: 0, callsPerHour: 0, noopRatioLast100: 1, secondsSinceLastPerceptionChange: 0 },
    budget: { callsToday: 0, dailyCap: 500, callsInWindow: 0, windowCap: 200, windowMinutes: 300 },
    tempoGuidance: "", highlightsTail: "", recentThoughts: "", inboxUnread: "", reactionsUnread: "",
  };
  const llm: LLMConfig = { baseUrl: "https://fake.local", apiKey: "k", model: "test-model" };

  it("compacts a large prior-step outcome and includes [COMPACTED …] in the prompt", async () => {
    // Track every prompt sent to the LLM. First call = compact.ts summarising
    // the big outcome. Second call = deliberate itself.
    const promptsSent: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      promptsSent.push(body.messages[body.messages.length - 1].content);
      // First call: compact.ts asks for a summary. Return a short summary.
      // Second call: deliberate asks for a decision. Return a noop.
      const content = promptsSent.length === 1
        ? "short summary that stands in for the huge blob"
        : JSON.stringify({ action: "noop", reason: "done" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch;

    const bigOutcome = { blob: "x".repeat(20_000) };
    await deliberate(role, perception, [], llm, [
      { tool: "big.tool", input: {}, outcome: bigOutcome },
    ]);

    // The deliberate prompt (last one sent) should contain the compacted marker,
    // not the raw 20KB blob.
    const deliberatePrompt = promptsSent[promptsSent.length - 1];
    expect(deliberatePrompt).toContain("[COMPACTED —");
    expect(deliberatePrompt).toContain("short summary");
    expect(deliberatePrompt).not.toContain("x".repeat(500));
  });

  it("leaves small prior-step outcomes verbatim (no LLM call for compaction)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "noop", reason: "done" }) } }] }));
    }) as typeof fetch;

    await deliberate(role, perception, [], llm, [
      { tool: "small.tool", input: {}, outcome: { ok: true } },
    ]);

    // Only one fetch — the deliberate call itself. No compaction round-trip.
    expect(fetchCalls).toBe(1);
  });
});
