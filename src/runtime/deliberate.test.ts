import { describe, it, expect } from "vitest";
import { parseDecision } from "./deliberate.ts";

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

  it("returns noop + rawOutput on truly unparseable text", () => {
    const raw = "I refuse to output JSON, sorry.";
    const r = parseDecision(raw) as any;
    expect(r.action).toBe("noop");
    expect(r.reason).toMatch(/unparseable/);
    expect(r.rawOutput).toBe(raw);
  });
});
