# ADR 0009 — extension architecture: uniform registry, memory providers, reserved core

**Status:** Accepted as a decision record (2026-08-27). **Implementation deferred
behind the ADR-0008 telemetry gate** — `memory.walk` shipped in AIC-128 stage 2;
graph, provider and registry work waits for evidence of ladder usage.
**Tickets:** [AIC-131](https://plane.danieljohnmorris.com/dan/ai-coworkers/issues/131)
(ships now: memory-map, review gate, compaction exclusion).

## Context

Three threads converged on one design space:

1. **ADR-0005 (Proposed, unimplemented)** already claims the extension surface:
   evaluators (post-action hooks) and services (long-lived I/O) with a
   registration pattern — `for (const e of evaluators) in src/index.ts`, empty
   list = current behaviour.
2. AIC-128 built the memory ladder, and the natural follow-ons (graph layer,
   community detection, a markdown/filesystem backend à la Headlong's design)
   all ask the same question: how do alternative memory backends plug in?
3. A sweep of eleven harnesses (2026-08-27) found the provider pattern shipped
   twice in the wild: Hermes has a `MemoryProvider` ABC (one external provider
   at a time), ElizaOS enforces memory scope at its adapter layer.

The question this ADR answers: **is memory a plugin, an adapter, or core — and
what is the one extension mechanism going forward?**

## Decision

1. **One uniform registration mechanism** for all extension types: tools,
   sensors, evaluators, services, and memory providers register through the
   same pattern ADR-0005 established. ADR-0005's interfaces survive unchanged;
   this ADR generalises its registration shape rather than superseding it.
   `MemoryProvider` joins `Evaluator` and `Service` as a third contract type.
2. **A reserved core list the registry cannot disable or bypass**: the audit
   sink (events.db writes), the boundary pre-execute check, the quiet gate,
   and tempo. Plugins may *provide* these (a different audit sink), never
   remove them. This is where "runs safely while nobody watches" lives; it is
   the browser-sandbox position — everything is an extension except the
   guarantee.
3. **Memory providers are config-selected, not dynamically discovered**:
   `MEMORY_BACKEND=sqlite|markdown` (or auto-detect of a Headlong-style
   directory), like `MCP_SERVERS` / `ACP_AGENT_CMD`. No plugin discovery
   machinery for storage; the harness stays readable end to end.
4. **SQLite is the bundled default provider and stays always-present.** The
   candidate second provider is the markdown/filesystem-as-graph backend
   (Headlong's design: files are nodes, frontmatter links are edges). Its
   trigger condition: a real consumer — most likely the `hermes-recall` skill
   wanting to read the same graph — not anticipation.

## Deferred rungs (telemetry-gated, same gate as ADR-0008's P3)

- Explicit graph layer over the ladder (nodes/edges views, one adjacency table).
- Community detection at reflect time (label propagation; communities become
  `memory-map.md` sections, god nodes become headings).
- `memory.walk` path mode (recursive-CTE walk between two memories).
- `MemoryProvider` extraction + the markdown backend implementation.

Gate: `memory.walk` usage data showing the ladder is actually walked. Until
then the seam is the module boundary (`src/runtime/memory.ts` + `mem_walk.ts`);
an interface with one implementation is a tax, not an option.

## Consequences

**+** One extension vocabulary; ADR-0005 slots in unchanged; third parties get
"write an evaluator / a provider" as targets.

**+** The reserved list is a small file a fork-reader can hold in their head.

**−** Every future capability type must decide: registry type or reserved
name. That decision belongs in an ADR amendment, not ad hoc.

## Not doing

- A plugin *discovery* mechanism (scanning directories for providers). Config
  names the mechanism; core wires it.
- Vector retrieval as a provider feature (per ADR-0008: lexical until
  telemetry says otherwise; QM's deliberate no-vectors choice is supporting
  evidence, Letta/ElizaOS's vector paths are the counter-example we are not
  following yet).
- Agent-curated harness-as-memory (Prime Agent's direction): role docs stay
  human-authored; `role.audit` polices drift.

## Reference

- [ADR 0005 evaluators + services](./0005-evaluators-services.md) — the
  registration pattern this generalises; interfaces unchanged.
- [ADR 0008 progressive-resolution memory](./0008-progressive-resolution-memory.md)
  — the ladder and the telemetry gate this defers behind.
- Harness sweep evidence (2026-08-27): Hermes `MemoryProvider` ABC, ElizaOS
  adapter-layer MemoryScope, SoulClaw DREAMS.md review surface, Eve
  compaction-exclusion, Letta memory stats. Sources in AIC-131.
