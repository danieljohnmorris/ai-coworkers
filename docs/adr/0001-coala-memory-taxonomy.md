# ADR 0001 — Adopt CoALA memory taxonomy for module names

**Status:** Accepted, 2026-08.

## Context

Long-running AI coworkers need multiple, distinct kinds of memory: what's in
context now, what happened last week, what has been learned about the world,
what is known about specific people and projects, and how the coworker
distills recent experience into future behaviour. The literature has
converged on names for these types — most prominently the CoALA framework
(Sumers et al., *Cognitive Architectures for Language Agents*, 2023,
[arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) — reinforced by
follow-on work from MemGPT/Letta, LangMem, Generative Agents, and Mem0.

Every framework we surveyed (ElizaOS, Hermes, OpenClaw, NanoClaw, Vercel Eve)
implements some subset of these types, but under inconsistent names —
`messageManager`, `factsManager`, `MEMORY.md`, `dreaming`, `providers`, and
so on. That inconsistency makes it hard to reason about coverage and to
borrow ideas across frameworks.

## Decision

We adopt CoALA's vocabulary as the canonical names for both source modules
and prompt sections in `ai-coworkers`, extended with the two operational
concepts that CoALA leaves implicit:

| CoALA term         | Our module            | Storage                                                                     |
| ------------------ | --------------------- | --------------------------------------------------------------------------- |
| Working memory     | (in-tick perception)  | RAM, per tick                                                               |
| Episodic memory    | `runtime/episodic.ts` | `state/events.db` (sqlite) + FTS5 virtual table                             |
| Semantic memory    | `runtime/semantic.ts` | `state/memory/MEMORY.md` (markdown, 2 KB cap)                               |
| Entity memory      | `runtime/entities.ts` | `state/entities/{people,projects}/<key>.md`                                 |
| Procedural memory  | `runtime/tools.ts`    | Registered `ToolDef` handlers; no learned self-editing in v1                |
| Reflective memory  | `runtime/reflect.ts`  | Weekly ritual: rollup → `memory.db#rollups`, learnings → `MEMORY.md`        |
| (Sensory buffer)   | `runtime/tick.ts`     | Sensor results assembled into perception; discarded after tick              |

Operational extensions kept from Hermes / OpenClaw / MemGPT:

- **Hard cap on semantic memory** — 2 KB. Forces distillation.
- **Injection scan on every third-party write** — `runtime/injection.ts`,
  applied by `semantic.propose()` and `entities.upsertPerson()`. Non-optional.
- **Scheduled compaction ritual** — weekly, not per-turn. Cost-controlled.
- **FTS5 first, embeddings never (yet)** — coworkers query by exact ticket
  IDs, PR numbers, and handles far more often than by semantic similarity.

## Consequences

- New modules and files must use the CoALA name; existing names already comply.
- `MEMORY.md` sections in the system prompt are labelled with the CoALA term
  (e.g. "MEMORY (semantic)", "ENTITIES") so the model itself can reason about
  what kind of memory it is reading.
- If we later add graph, embedding, or procedural-learning memory, they get
  their own module named per CoALA and slot into the same table above.

## References

- CoALA — arXiv:2309.02427
- Generative Agents (Park et al.) — arXiv:2304.03442
- MemGPT (Packer et al.) — arXiv:2310.08560
- LangMem SDK announcement — langchain.com/blog/langmem-sdk-launch
- Internal research: memory taxonomy comparison across ElizaOS, Hermes,
  OpenClaw, NanoClaw, Vercel Eve (conversation, 2026-08).
