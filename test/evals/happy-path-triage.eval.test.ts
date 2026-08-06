// Scenario: fresh untriaged ticket appears → coworker comments once →
// next tick is quiet.
//
// Locks in the core value prop: a coworker acts when there's work,
// and stays silent once it has handled the work.

import { describe, it } from "vitest";
import { runScenario, expect, count } from "./harness.ts";

describe("scenario: happy-path triage", () => {
  it("sees one untriaged issue → comments once → next tick noops", async () => {
    await runScenario({
      role: { tools: "- fake" },
      sensors: [
        { name: "fake.new_issues", result: { issues: [{ id: "ILO-42", title: "parser bug" }] } },
      ],
      actions: [
        { name: "fake.comment", handler: () => ({ ok: true, id: "c1" }) },
      ],
      llmSequence: [
        // Tick 1: act.
        { action: "call", tool: "fake.comment", input: { issueId: "ILO-42", body: "P2 — needs repro" }, reason: "triage" },
        // Tick 2: same sensor result → nothing new → noop.
        { action: "noop", reason: "backlog quiet" },
      ],
      ticks: 2,
      expect: ({ events, tickOutcomes, actionCalls }) => {
        // Exactly one action fired.
        expect(actionCalls).toHaveLength(1);
        expect((actionCalls[0].input as any).issueId).toBe("ILO-42");
        // Exactly one action event logged.
        expect(count(events, "action")).toBe(1);
        // Second tick reached deliberate (didn't quiet-skip) but chose noop.
        expect(tickOutcomes[1].quiet).toBe(false);
        expect(tickOutcomes[1].didNoAction).toBe(true);
      },
    });
  });
});
