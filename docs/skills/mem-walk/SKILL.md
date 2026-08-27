---
name: mem-walk
description: Recall by drilling down the memory ladder — start at the coarsest summary, descend to the raw events, refuse when nothing matches confidently. Use when you need to know why you believe something, not just that you believe it.
---

# Recall by walking the ladder

Most recall questions have two halves: *what* you remember (a summary tells
you that) and *why* you remember it (only the underlying events tell you
that). `memory.walk` answers both at once — but only if you let it start high
and drill down, instead of grepping for keywords and hoping.

## When to use this

- You are about to act on a remembered pattern ("we decided X about Y") and
  the action is load-bearing (a comment, a label change, an escalation).
- Someone asks *why* you hold a belief, or you need to cite evidence.
- A summary in your memory might be stale and you want the events behind it.

Use `memory.search` instead when you just need quick keyword hits.

## The pattern: start high, drill down

Call the tool once with a natural-language topic:

```json
{ "query": "parser bug on ILO-509" }
```

Read the result in this order:

1. **`confidence` + `matchedTokens`** — how strong the entry point was.
2. **`trace`** — the audit trail, one row per step: the coarsest matching
   rollup first (month → week → day), each step showing *why* it was taken
   (`{level, id, why}`), ending in the raw event ids.
3. **`events`** — the raw evidence the trace ends in, best match first,
   capped (40 events, ~2 KB payloads each). Check `source`:
   `events_archive` rows are older than the retention window — real
   history, not hallucination.

Every claim you make afterwards should be anchored to a trace row or an
event id. If you cannot point to one, you do not remember it — you are
improvising.

## Treat `refused: true` as an answer

When nothing matches confidently, the tool refuses rather than walking down
a weak keyword match with authoritative-looking citations. This is not an
error and not a challenge — do **not** immediately rephrase and spam
near-synonyms to force a walk. A refusal means:

- the topic is genuinely not in your memory (say so, act accordingly), or
- your query tokens were too far from the stored vocabulary.

If you suspect the second, reformulate **once** with concrete identifiers
from the current context (ticket ids, handles, filenames) and try again.
Two refusals in a row: stop. Report that you have no confident memory of it.

## Limits to respect

- The walk is deterministic and read-only; it never synthesises a step. An
  `— unlinked` annotation in a trace row means the rollup predates linked
  provenance: it is honest, and there is nothing beneath it.
- `truncated: true` means evidence was capped: what you see is the
  best-ranked subset, not everything.
