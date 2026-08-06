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

## Scored benchmark (AIC-83)

The `*.eval.test.ts` files are **regression scenarios** (pass/fail).
The **scored benchmark** in `bench.mjs` + `scenarios/*.json` is a
different thing: a rubric-graded harness you can quote a single
number from ("Watchtower scores 82% on the ai-coworkers SRE bench
v1"). Modelled on Tracer-Cloud/opensre's `tests/synthetic/`.

Each scenario in `scenarios/*.json` declares:

- `name`, `role`, `prompt`, `sensors` — the setup
- `expected_root_cause` — what the coworker should figure out
- `required_evidence[]` — strings the coworker MUST cite
- `red_herrings[]` — actions the coworker MUST NOT propose

`bench.mjs` scores each on 3 criteria (weights):

- **evidence_coverage** (0.40): fraction of `required_evidence`
  found in the coworker's `reason` + `thoughts` + `input`.
- **root_cause_match** (0.35): token-overlap ratio between the
  coworker's response and `expected_root_cause`.
- **red_herring_avoidance** (0.25): 1.0 with none matched, minus
  0.5 per hit, floored at 0.

Run:

```bash
OLLAMA_API_KEY=... make bench       # print the leaderboard
make bench-update-readme            # regenerate and refresh README stats line
```

`bench.mjs` spins up a real coworker per scenario, wires the scenario
sensors, drops the prompt into the inbox, runs one tick against a
**real LLM** (from `OLLAMA_API_KEY` + `BENCH_MODEL` / `COWORKER_MODEL`),
and scores the coworker's actual `reason` + `thoughts` + `action.input`.
No stubs — if `OLLAMA_API_KEY` isn't set the bench exits with a clear
message rather than pretending to score anything. Override the model
with `--model <name>` or `BENCH_MODEL=<name>`.

`score()` is exported + unit-tested independently (`bench.test.ts`) so
the rubric can be verified without spending LLM tokens.
