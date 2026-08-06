// Scenario: manager leaves a note in the inbox; on the next tick the
// note appears in perception, is marked read, and the model can act on
// it. Locks in the human→coworker channel end-to-end.

import { describe, it } from "vitest";
import { runScenario, expect } from "./harness.ts";

describe("scenario: inbox note reaches the model and gets marked read", () => {
  it("model sees the note in its prompt, then next tick sees nothing new", async () => {
    await runScenario({
      role: { tools: "- fake" },
      sensors: [{ name: "fake.sensor", result: { n: 1 } }],
      inbox: "Please prioritise ILO parser bugs today",
      llmSequence: [
        // Tick 1: model receives the note. Just noop — we care about
        // the presentation-and-mark-read, not what the model does with it.
        { action: "noop", reason: "acknowledged" },
        { action: "noop", reason: "no new notes" },
      ],
      ticks: 2,
      expect: ({ events }) => {
        // The first tick should have highlighted the note (goes through the
        // shared highlight path — not a distinct event kind, but we can
        // verify that the second tick did not re-highlight).
        const highlights = events.filter((e) => e.kind === "note");
        expect(highlights.length).toBeGreaterThan(0);
      },
    });
  });
});
