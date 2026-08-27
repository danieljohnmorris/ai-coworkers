# ADR 0005 — evaluators + services (design spike)

**Status:** Proposed (2026-08-06). No implementation yet.
**Superseded in part by:** [ADR 0009](./0009-extension-architecture.md) generalises the registration pattern into a uniform registry (memory providers join evaluators/services). Interfaces here survive unchanged; implementation still pending.
**Ticket:** [AIC-81](https://linear.app/ilo-lang/issue/AIC-81)

## Context

ElizaOS exposes four primitives at runtime: **actions**, **providers**,
**evaluators**, **services**. We already have direct analogues for two of
those:

| ElizaOS  | ai-coworkers analogue |
|---|---|
| Providers (prompt context injection) | Sensors (`ToolDef.kind = "sensor"`), plus explicit perception assembly in `tick.ts` |
| Actions (agent capabilities) | Actions (`ToolDef.kind = "action"`) |
| Evaluators (post-response processing) | Partial — `dreamOnce` runs weekly; `role_audit` runs daily. No per-tick, per-action hooks. |
| Services (long-lived singletons) | Absent — every sensor is a per-tick fetch |

This ADR proposes the minimal interface changes to close those two
gaps, and decides *whether* to. Actual implementation is a separate
follow-up.

## Gap 1 — evaluators (post-action hooks)

### What's missing

Cross-cutting concerns that need to see every action, not just fire on
a schedule:

- **Metrics**: per-tool p50/p99 latency, error rate, boundary-block rate.
  Today we can query `events.db` after the fact; we can't easily hand
  a rolling window to Prometheus / OpenTelemetry.
- **PII redaction**: strip email addresses / tokens from action outcomes
  before they land in `state/highlights.log` or get sent to Buzz/Slack
  as `ask` payloads.
- **Moderation**: block outbound content that matches a policy pattern
  (offensive language, unverified claims) — after deliberation, before
  external post.
- **Per-tool cost accounting**: attribute LLM tokens to the tool call
  that motivated them, useful for budget breakdown by responsibility.
- **Learning signal capture**: convert a `reactions.log` 👍 on a specific
  highlight into an event tagged with the tool call that produced it, so
  reflect can preferentially retain patterns that got positive feedback.

Today these would live in tick.ts, polluting it with cross-concerns.
Ritual-based batch processing catches most cases but not "block this
outbound message before it leaves the process."

### Proposed shape

```ts
export interface Evaluator {
  name: string;
  // Fires after each tool call in the tick's chain, before the outcome
  // is written to events.db. May transform the outcome (redaction),
  // may return { block: true } to short-circuit further chained calls,
  // may push its own events. Errors are logged, not thrown — an
  // evaluator crash never breaks the tick.
  onAction(evt: {
    tool: string;
    input: unknown;
    outcome: unknown;
    dryRun: boolean;
  }): Promise<
    | void
    | { outcome?: unknown; block?: boolean; note?: string }
  >;
  // Optional: fires when the boundary layer rejects an action. Useful
  // for a "why did we get blocked" observability evaluator.
  onBoundaryBlock?(evt: {
    tool: string;
    input: unknown;
    reason: string;
  }): Promise<void>;
}
```

Register evaluators alongside tools in `src/index.ts`:

```ts
import { redactPII } from "./evaluators/redact.ts";
import { costAttribution } from "./evaluators/cost.ts";
const evaluators = [redactPII, costAttribution];
```

Tick loop wires them at the two existing hook points (`log.event("action",
...)` and `log.event("boundary.block", ...)`).

### Tradeoffs

**+** Cross-cutting concerns get a proper home. No more "grep tick.ts for
where to add my PII redaction."

**+** Third-party evaluator libraries become easy to write (redaction,
metrics exporters).

**−** Every tool call gets extra latency (~ms per evaluator). Fine for
network-bound tools; noticeable for pure-Node ones.

**−** Debugging becomes harder: "why did the outcome I posted not match
what the tool returned?" answer: an evaluator transformed it. Need good
logging of the before/after per evaluator.

## Gap 2 — services (long-lived singletons)

### What's missing

Every sensor is a per-tick fetch today. That's fine when the underlying
system supports polling (Linear, GitHub REST). It's wasteful when the
system supports push (Slack RTM/socket-mode, GitHub webhooks via the
existing `/wake` endpoint, Linear webhooks). Push means:

- **Lower latency**: a Slack mention arrives at tick+250ms instead of
  waiting up to `TICK_INTERVAL_MS` for the next poll.
- **Lower rate-limit pressure**: no polling means no polling ceiling.
- **Fresher perception**: we can invalidate sensor caches the moment a
  write we care about lands upstream.

We already have `/wake` — but it only sets `forceDeliberate` for the next
tick. A real service loop would push events into an inbound queue that
becomes part of perception directly.

### Proposed shape

```ts
export interface Service {
  name: string;
  // Called once at coworker startup. Returns a cleanup function.
  start(ctx: ServiceCtx): Promise<() => Promise<void>>;
}

export interface ServiceCtx {
  coworker: string;
  env: NodeJS.ProcessEnv;
  emit(evt: { kind: string; payload: unknown }): void;   // → events.db
  wake(reason: string): void;                            // → forceDeliberate next tick
}
```

Register in `src/index.ts`:

```ts
import { slackSocketService } from "./services/slack_socket.ts";
import { githubWebhookService } from "./services/github_webhook.ts";
const services = [slackSocketService, githubWebhookService];
```

`src/index.ts` calls `start()` for each after the tick loop's `while`
starts; keeps the cleanup functions and calls them on SIGINT/SIGTERM.

### Tradeoffs

**+** Real push support without inventing per-source machinery.

**+** Cleaner separation: services own I/O lifetime; tick loop stays a
finite state machine of perceive → deliberate → act.

**−** A crashed service that isn't caught kills the whole coworker.
Requires the same `try/catch` + restart discipline the tick loop already
has around handlers.

**−** Ordering guarantees between service-pushed events and sensor
snapshots get fuzzy — a sensor read at tick T might miss an event a
service pushed at T-1ms. Not a correctness problem (we're not
transactional) but worth calling out.

## Decision

**Adopt both, staged.**

1. **Evaluators first** (smaller surface, higher immediate value). Ship
   as `src/runtime/evaluators.ts` with two initial concrete evaluators:
   - `redactPII` (regex-based; documented pattern list)
   - `costAttribution` (attributes token usage to the deliberation that
     spawned the tool call)
   That's a 1-2 day ticket with tests.

2. **Services later**, after we've validated the interface against a
   real second use-case (currently only Slack RTM feels concrete).
   Ship at that point as `src/runtime/services.ts` + one concrete
   service (`slackSocketService`).

Both should keep the "opt-in and backwards-compatible" pattern the
credentials broker (AIC-74) and declarative rituals (AIC-80) already
established: registration is a `for (const e of evaluators)` in
`src/index.ts`; empty list = current behavior unchanged.

## Consequences

**+** Closes the ElizaOS gap without importing ElizaOS's runtime. Our
tick loop stays, plus these two well-scoped extension points.

**+** Third-party contributions get a cleaner target ("write an
evaluator") than "modify tick.ts".

**−** Two more concepts for a reader to hold. Documented against the
existing four (sensors, actions, memory tiers, rituals) — six primitives
total. That's the design vocabulary now; ADR 0001 already sets the
precedent with the CoALA taxonomy.

## Not doing

- Anthropic-style "evaluator agents" (a separate LLM judging outputs).
  That's a bigger idea and needs its own ADR — expensive per action, and
  we already have the reactions log for cheap human signal.
- A pub-sub bus. Evaluators and services are called directly; the
  primitives are simple enough that a bus would be over-abstraction.

## Reference

- ElizaOS core primitives: <https://github.com/elizaOS/eliza>
- Related ADRs: [0001 memory taxonomy](./0001-coala-memory-taxonomy.md),
  [0002 ACP](./0002-acp-code-delegate.md),
  [0003 sandbox](./0003-container-isolation.md).
