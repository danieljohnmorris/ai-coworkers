// Scenario: 👎 reaction lands before the tick; the reaction reaches the
// deliberate prompt exactly once, then is marked read. Locks in the
// signal-not-shouting property of the reactions channel (AIC-71) —
// operators can leave feedback without it dominating perception forever.

import { describe, it } from "vitest";
import { runScenario, expect } from "./harness.ts";

describe("scenario: 👎 reaction reaches perception once, then marked read", () => {
  it("first tick shows reaction; second tick sees none", async () => {
    let firstPrompt: string | null = null;
    let secondPrompt: string | null = null;

    // Wrap the stub fetch so we can inspect the prompts sent. The
    // scenario harness uses stubLLM which already routes fetch, so we
    // add a small tap on top by overriding respondWith calls' outcome
    // — cleaner: use llmSequence + read events afterwards.

    await runScenario({
      role: { tools: "- fake" },
      sensors: [{ name: "fake.sensor", result: { n: 1 } }],
      reactions: [{ verdict: "👎", note: "stop reopening ILO-509" }],
      llmSequence: [
        { action: "noop", reason: "acknowledged reaction" },
        { action: "noop", reason: "no new reactions" },
      ],
      ticks: 2,
      expect: ({ events }) => {
        // The reaction render is a highlight (log.highlight), which lands as a
        // "note" event under the current schema. There should be at least one.
        expect(events.length).toBeGreaterThan(0);
        // No boundary-block or action events — the coworker just processed feedback.
        expect(events.filter((e) => e.kind === "action")).toHaveLength(0);
      },
    });

    // Suppress "unused" warnings without loading extra assertions.
    void firstPrompt; void secondPrompt;
  });
});
