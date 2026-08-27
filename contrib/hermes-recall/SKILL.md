---
name: hermes-recall
description: Recall from your own memory by drilling down — start at the coarsest summary you have, descend level by level to the underlying notes and log rows, and refuse to answer when nothing matches confidently. Use whenever a remembered belief is about to drive an action.
---

# Drill-down recall over your own memory

Your memory has layers whether or not you planned them that way: distilled
summaries and index notes at the top, and underneath them the raw material
— individual notes, log rows, session history. Most recall mistakes come
from reading only the top layer and trusting it, or from grepping the raw
layer and drowning. This skill is the middle path: **start high, drill
down, refuse when nothing matches.**

## The playbook

**Step 1 — Index your coarsest layer.**
List your memory inventory before touching content: the files in your
notes/memory directory (names only) and, if you keep a SQLite database of
logged activity, its table names. This is cheap and orients everything
after it. Do not open file bodies yet.

**Step 2 — Score entry points lexically.**
Pick the two to five distinctive tokens from the question (identifiers
beat words: ticket ids, project names, handles). For each candidate in the
index, ask: how many of those tokens appear in it? Compute the fraction
`matched tokens / query tokens` for your best candidate.

**Step 3 — Apply the confidence gate.**
If the best fraction is below one half, **stop and refuse**: report that
you have no confident memory of the topic. Do not walk, do not guess, do
not rephrase endlessly. A refusal is a valid, useful answer — walking down
a weak match produces confident-sounding citations to the wrong thing.

**Step 4 — Walk down, one level at a time.**
From the best-matching coarse entry point, descend to the finer material
it points at: open the summary, find the references it makes (dates, note
titles, row ids), and score those the same way. Keep at most three
candidates per level. Stop when you reach raw material — an actual note or
log row, not another summary.

**Step 5 — Answer with the trace.**
Report the answer together with the path you took: which index entry you
entered at, which references you followed, which notes or rows you ended
in. Cap the raw material you quote (a handful of rows, excerpts not whole
files). If the path dead-ends — a summary with no references beneath it —
say so plainly; never invent the missing rung.

## Rules of thumb

- Identifiers (`PROJ-123`, a handle, a filename) are the strongest tokens;
  common words are noise.
- Two refused attempts in a row means the memory genuinely is not there.
  Say that and act on the present context instead.
- A summary with no link to anything beneath it is an honest dead end, not
  a puzzle to solve by guessing.
