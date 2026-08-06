# Behaviour evals — golden scenarios

Higher-level integration tests than `src/**/*.test.ts`. Each file here
seeds a coworker, drives one or more `tick()` calls with a fake LLM +
fake sensors, and asserts on **emergent** behaviour: what the coworker
did across the tick pipeline as a whole, not what one function returned.

## When to add a scenario

- A user-facing invariant you rely on ("dry-run means no side effect
  ever reaches the target system", "quiet ticks skip the LLM call").
- A multi-tick emergent property ("adaptive backoff kicks in after 3
  quiet ticks, resets on activity").
- A cross-module interaction that no single unit test covers ("a
  boundary block prevents the outcome from being written to events.db").

Do NOT put here what belongs in a unit test — one function, one
input-output pair. Those live next to the source file.

## Shape

Every scenario file exports a describe block. Use `stubLLM()` from
`test/fixtures.ts` for LLM stubbing and `runScenario()` from
`test/evals/harness.ts` for the setup boilerplate.

```ts
import { runScenario } from "./harness.ts";

describe("scenario: happy-path triage", () => {
  it("sees an untriaged issue → posts one comment → next tick is quiet", async () => {
    await runScenario({
      role: "triage",
      sensors: [{ name: "linear.new_issues", result: { issues: [/*…*/] } }],
      llmSequence: [
        { action: "call", tool: "linear.comment", input: { /*…*/ }, reason: "…" },
        { action: "noop", reason: "backlog quiet" },
      ],
      expect: (log, events) => {
        expect(events.filter(e => e.kind === "action")).toHaveLength(1);
        expect(events.filter(e => e.kind === "tick.quiet")).toHaveLength(1);
      },
    });
  });
});
```

## When a scenario breaks

Failing a behaviour eval means either:

1. **A real regression** — the pipeline changed and now behaves differently.
   Fix the code, not the test.
2. **The invariant genuinely shifted** — a deliberate change to the
   contract. Update the scenario and mention the ticket in the commit.

Never delete a scenario silently.
