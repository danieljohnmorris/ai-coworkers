# ADR 0006 — filesystem-first storage

**Status:** Accepted (2026-08-06). Retrospective — codifies the shape
already present in the codebase so future contributors don't
"upgrade" it to a graph or a relational schema by reflex.

## Context

Mature agent frameworks tend to reach for a heavier store the moment
"entities" enter the vocabulary. ElizaOS keeps a structured `facts`
memory. LangGraph delegates to whatever persistence you wire behind
its checkpointer — typically Postgres. Anything that talks about
"relationships" in a design doc gravitates toward Neo4j, RDF, or a
bespoke edges table with foreign-key discipline.

We deliberately did not do that. Every long-lived piece of coworker
state in this repo is a **human-readable file on disk**, with SQLite
used only where an index or a searchable log genuinely earns its
keep. This ADR names that choice so it isn't quietly reversed.

## Decision

Storage taxonomy for a coworker (`coworkers/<name>/state/…`):

| Concern | Store | Shape |
|---|---|---|
| Entity notes (people, projects) | `entities/{people,projects}/<key>.md` | markdown, one file per entity |
| Freeform agent scratchpad | `notes.md` | append-only markdown, 4 KB cap |
| Semantic memory (learnings) | `memory/MEMORY.md` | curated markdown |
| Journal / dreams | `journal/*.md`, `memory/DREAMS.md` | markdown |
| Role docs | `coworkers/<name>/role/*.md` | markdown |
| Event log | `events.db` (SQLite) | append-only rows + FTS5 index |
| Rollups / promises / people-notes index | `memory.db` (SQLite) | tables, but only as an index over the markdown truth |
| Relationships between entities | `entities/relationships.jsonl` | append-only JSON lines |

Two rules the taxonomy enforces:

1. **The markdown is the source of truth.** If `notes.md` and
   `memory.db` disagree, `notes.md` wins. SQLite is a rebuildable
   index over on-disk facts, not the primary record.
2. **Relationships between entities are prose-first.** The Dan card
   mentions ILO because it says so in English. A tick's entity
   detector finds them by substring + alias match, not by graph
   traversal. The edges file (`relationships.jsonl`) exists for the
   cases where an explicit typed edge earns its keep, but it is
   flat, append-only, and readable in `less`.

## Consequences

**+** `cat coworkers/alex/state/entities/people/dan.md` is a complete,
truthful answer to "what does Alex know about Dan?" — no join, no
SDK, no query language.

**+** State is diffable with `git diff`. Every coworker's memory can
be inspected, backed up, and forked with the tools every engineer
already has. This is the same reason role docs are markdown, not JSON.

**+** No schema migrations across versions. Adding a new field to an
entity note is "write a new sentence." Dropping one is "delete the
sentence." No `ALTER TABLE`, no rollback plan.

**+** Forkability. A downstream user is not signing up to defend our
choice of DB engine or migrate off it later. The whole coworker is
`rsync`-able.

**−** No graph-query power. "Find all P0 tickets assigned to people
who left the company" is a script that greps entity files, not a
Cypher query. When we need that, we write the script; if we ever
need it enough that scripts stop scaling, we revisit (see below).

**−** Relationship queries are grep-shaped. You can find every
mention of "ILO" across every entity file cheaply, but ranking by
recency or filtering by edge type requires reading the file. Fine at
current scale (dozens of entities per coworker); would hurt at
thousands.

**−** No transactions across files. A crash mid-write to `notes.md`
can leave a partial entry. The 4 KB cap and append-only shape make
this recoverable-by-eye rather than corrupting.

## Precedent

- **Vercel Eve** — the coworker *is* a directory of markdown. Same
  ergonomic bet: humans edit state directly with the same tools
  they use to edit code.
- **Hermes** — state files, not a state service. Skills are
  markdown. Coworker memory lives on disk.
- **MemGPT archival** — searchable text over rigid schema. The
  archival tier is deliberately unstructured because the retrieval
  path is FTS, not SQL.

Contrast:

- **ElizaOS** — structured `facts` memory with typed keys. Powerful
  for cross-agent aggregation; heavier to fork and reason about.
- **LangGraph** — whatever you persist. In practice, Postgres or
  Redis. Assumes an ops surface we don't want to require.
- **Any Neo4j / RDF agent memory** — beautiful for "who works with
  whom on what"; unmaintainable at coworker-per-directory scale.

## When to reconsider

- We ship a "query my whole fleet" surface that needs cross-coworker
  relational answers ("which of my 20 coworkers ever escalated to
  Slack channel X?"). Grep across 20 directories is fine; grep
  across 2,000 is not.
- Entity counts per coworker cross ~10,000 and detection latency
  starts showing up in tick timing.
- A concrete downstream use case demands a typed edge query — not
  "graphs would be nice" but "we cannot answer question Q at all
  today." At that point, add a materialised view (still derived
  from markdown), not a schema migration.

## Reference

- Related ADRs: [0001 memory taxonomy](./0001-coala-memory-taxonomy.md),
  [0004 events.db single file](./0004-events-db-single-file.md),
  [0005 evaluators + services](./0005-evaluators-services.md).
- Implementation: `src/runtime/entities.ts`, `src/tools/memory.ts`
  (`memory.note` / `memory.notes_read`), `src/runtime/semantic.ts`.
