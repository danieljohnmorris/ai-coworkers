// Scenario: model chooses to comment mentioning a forbidden target →
// boundary check rejects it BEFORE the tool runs. Locks in the
// "policy is enforced pre-execute, not post-hoc" invariant.

import { describe, it } from "vitest";
import { runScenario, expect, count } from "./harness.ts";

describe("scenario: boundary blocks an action", () => {
  it("model chose to mention 'secret' → boundary.block event, no action fires", async () => {
    await runScenario({
      role: {
        tools: "- fake",
        boundaries: "## Must not touch\n- secret\n\n## Resource limits\n- Max LLM calls per day: 500",
      },
      sensors: [{ name: "fake.sensor", result: { n: 1 } }],
      actions: [{ name: "fake.comment" }],
      llmSequence: [
        { action: "call", tool: "fake.comment", input: { body: "expose secret and admin panel" }, reason: "" },
      ],
      expect: ({ events, actionCalls }) => {
        expect(actionCalls).toHaveLength(0);                    // handler never fired
        expect(count(events, "boundary.block")).toBe(1);         // block was logged
        expect(count(events, "action")).toBe(0);                 // no action event
      },
    });
  });
});
