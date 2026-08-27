# ADR 0008 — progressive-resolution memory (the ladder)

**Status:** Proposed (2026-08-27). Implementation starting under AIC-127/128.
**Tickets:** [AIC-127](https://plane.danieljohnmorris.com/dan/ai-coworkers/issues/127)
(retention archive), [AIC-128](https://plane.danieljohnmorris.com/dan/ai-coworkers/issues/128)
(ladder + `mem.walk`), [AIC-129](https://plane.danieljohnmorris.com/dan/ai-coworkers/issues/129)
(this ADR).

## Context

Memory today is two columns that do not know about each other:

1. **Curated semantic memory** — `MEMORY.md` capped at 2 KB, distilled weekly by
   the reflect ritual, plus `decisions`, `people`, `promises` tables. Decides what
   matters. Loses everything nobody thought to keep.
2. **Episodic rollups** — `rollups` rows at day/week/month granularity over the
   hot event window. Automatic. Cannot be navigated, and the raw events under
   them are deleted after the retention window (`reflect.ts` prune cascading
   into `events_fts`), so the ladder has no bottom rung at all.

The trigger for this ADR was [Headlong](https://github.com/laude-institute/headlong)
(Laude Institute, August 2026): a Bash runtime whose agent thinks continuously,
and whose published design doc,
[`unified_progressive_resolution_memory.md`](https://github.com/laude-institute/headlong/blob/main/design/unified_progressive_resolution_memory.md),
describes exactly the structure we lack: every memory entry at a resolution
level, linked to coarser summaries above and finer detail below, navigated
top-down at roughly 10 summaries per level (log-scale cost). Their doc is
marked NOT YET IMPLEMENTED; their production memory has the same two
disconnected columns ours does. We implement the design on SQLite first.

A vetting pass against the project's positioning (quiet gate, Hermes-community
funnel, small forkable harness) set the decisions below.

## Decision

1. **Adopt the ladder, as one deliverable** (AIC-128): schema links
   (`rollups.level`, `parent_id`, source event ranges; decisions record source
   event-ids) plus the `mem.walk` drill-down tool (FTS5 entry point → coarsest
   summaries → children → raw events) plus a navigation skill. The schema alone
   ships nothing; the tool alone cannot navigate; they land together with an
   explicit refusal path when no entry point is confident.
2. **Archive before building** (AIC-127): replace the retention delete with an
   `events_archive` table. The ladder is worthless if level 0 is gone; a
   product pitched on auditability must not delete its own audit trail.
3. **Ship the navigation pattern as a standalone Hermes skill** (inside
   AIC-128): genericized drill-down recall over notes, reference implementation
   against our schema. It is the inbound item for the Hermes community and
   follows the adapters-not-plugin-formats thesis.
4. **Frequent tier-1 sealing: DEFERRED.** Hourly cheap-model sealing of small
   blocks adds background token spend to a product whose pitch is that most
   ticks never reach the model. Day/week/month + raw is a four-rung ladder,
   enough to validate drill-down. Revisit only if AIC-128 usage telemetry shows
   the day rung is too coarse.
5. **Monologue / always-think ticks: CUT.** An opt-in idle rumination mode is
   the one item that contradicts the sharpest row in `docs/comparison.md`
   ("decides when NOT to act"). Converters arrive from chat-native
   always-thinking agents; shipping one says the boundaries story was a phase.
   The honest version of initiative already exists: human-authored scheduled
   rituals. If quiet gaps later prove to miss things, the answer is better
   rollups, not self-talk.

## Failure modes the implementation must engineer against

- **Link rot:** LLM-written rollups citing wrong or nonexistent event ranges.
  Validate ranges at write time; never synthesise provenance for legacy
  backfill — unlinked old entries are honest, faked links are not.
- **Confident-wrong recall:** an FTS keyword miss walking down the wrong branch
  with authoritative-looking citations. `mem.walk` must refuse when it has no
  confident entry point.

## Consequences

**+** "Auditable actions" extends to "auditable memory": a coworker can answer
why it remembers something by walking month → week → day → the exact raw
events, every step an audit row. No surveyed framework ships this today.

**+** The Hermes skill turns the differentiator into a funnel artifact.

**−** `events.db` grows monotonically (bounded by event size; archival table
documented with a manual purge path). WAL checkpoint discipline added in
AIC-127.

**−** Two more schema fields and one tool on the reader's plate; the
navigation skill must stay one page.

## Not doing

- Continuous background thinking (see Decision 5).
- Replacing FTS5 with embeddings as the entry point. Wrong-entry-point
  mitigation is the refusal path, not a vector index; revisit with evidence.
- Same-level `related` links (Headlong's phase 5). The drill-down skill can
  discover siblings under a shared parent without stored edges.

## Reference

- Headlong design doc (source of the ladder, levels, and cost model):
  `design/unified_progressive_resolution_memory.md` in the Headlong repo.
- Comparison context: [docs/comparison.md](../comparison.md) (Headlong section
  added alongside this ADR).
- Related ADRs: [0001 memory taxonomy](./0001-coala-memory-taxonomy.md),
  [0004 events.db single file](./0004-events-db-single-file.md),
  [0005 evaluators + services](./0005-evaluators-services.md).
