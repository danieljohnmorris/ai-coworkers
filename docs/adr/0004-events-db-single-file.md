# ADR 0004 — keep events.db as one file (bench outcome)

**Status:** Accepted (2026-08-06). No schema split.
**Ticket:** [AIC-75](https://linear.app/ilo-lang/issue/AIC-75)

## Context

The NanoClaw ticket lineage suggested splitting per-session state into
two SQLite files (`inbound.db` + `outbound.db`) with a single writer
each, to eliminate lock contention. We inherited the idea as a spike:
benchmark first, only act if there's a real problem.

## Bench

`bin/bench-events-db.mjs 5000` on the current schema (single events.db,
FTS5 AFTER INSERT trigger from `initEpisodic`, no explicit WAL, defaults):

| Mode | Time | Inserts/sec | Ratio to serial |
|---|---|---|---|
| serial | 635ms | 7,872 | 1.00× |
| batched (BEGIN/COMMIT) | 66ms | 75,922 | 9.6× |
| **two writers (async, interleaved)** | 632ms | **7,911** | **1.00×** |

Rerun on your machine with `node --experimental-strip-types --no-warnings
bin/bench-events-db.mjs [N]`.

## Interpretation

Two-writer throughput is **identical** to serial (1.00×), not degraded.
The reason: `node:sqlite` is synchronous, so two Promise-yielding writers
in the same process end up serialised by the event loop against the same
prepared statement — there is no true parallelism to contend over.

The theorized contention only appears when **separate processes** write to
the same file simultaneously. That is not our topology today: each
coworker owns its own directory tree and only its own tick loop writes
`state/events.db`. External wakes go via HTTP → tick.forceDeliberate,
not a second writer.

## Decision

**Keep events.db as one file.** Splitting into inbound/outbound would
add schema, migration, and query complexity for zero measured gain in
our actual workload.

## When to revisit

- If we add a second process per coworker (e.g. a long-lived webhook
  receiver that writes directly to events.db instead of routing through
  the tick loop), rerun the bench in `two-process` mode. That's a real
  cross-process contention scenario and the split becomes worth it.
- If the FTS5 trigger cost dominates a real tick (visible as `tick.end`
  duration_ms > 200ms on a healthy coworker), the batched mode result
  (75k inserts/sec, 9.6× serial) hints at a fix: wrap multiple event
  writes per tick in a single BEGIN/COMMIT. Cheap change, meaningful.
- If a fleet dashboard starts hammering a coworker's events.db with
  read-side queries, we might need WAL mode (`PRAGMA journal_mode=WAL`)
  to let reads and writes proceed without blocking each other. Also a
  cheap change that doesn't require splitting the file.

## Reference

- Bench script: `bin/bench-events-db.mjs`
- Related: the CI flake fix in `test/tick.test.ts:113` uses the batched
  pattern (see the commit fixing that flake), and validated in-process
  serial insert cost on CI is ~10ms per row when unbatched — which is
  why the test was hitting the 5s timeout.
