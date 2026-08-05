# ai-coworkers

Long-running AI coworkers with roles, responsibilities, and boundaries — not one-shot
task agents. Each coworker is a persistent process with a persona, an area of
responsibility, sensors that read the world, actions gated by explicit authority,
a tick loop that decides whether to act, memory that grows and compacts, and a
hygiene layer that cleans up after itself.

## How a coworker works

Each coworker is a long-running process that repeats a **tick loop**:

1. **Sense.** Run every read-only sensor the coworker's role allows (new
   Linear issues, Slack mentions, replies to its own comments, current time,
   its own resource usage). Capture results.
2. **Perceive.** Combine sensor output with the recent action log, pending
   promises to itself, and short memory rollups into one "state of the world"
   snapshot.
3. **Deliberate.** Feed that snapshot plus the role documents (as a cached
   system prompt) to an LLM and ask: given who you are, what you own, and what
   you're allowed to decide alone — take one action, or nothing.
4. **Act (or don't).** If the model chose an action, hard-check it against
   `BOUNDARIES.md` before executing. Doing nothing is a first-class choice
   and often the correct one.
5. **Record.** Every step above is written to a structured event log. Side
   effects (git worktrees, subprocesses, scratch dirs) are registered so the
   next hygiene sweep can clean them up.

Ticks can be time-driven (default: every 5 minutes) or event-driven (Linear
webhook, incoming Slack message) — both funnel into the same loop.

## Coworker archetypes

Same runtime for both. Only the tools they declare differ.

- **Non-technical** (Alex the triage engineer, Priya the PM, Kai the comms lead) —
  Linear, Slack, Gmail, Google Docs, Obsidian.
- **Technical** (Sam the PR reviewer, Rin the bug-fixer) — all of the above plus
  `code.delegate` which spawns a coding harness (Pi / Claude Code / Claude Agent SDK)
  inside a managed git worktree, with automatic cleanup.

## Design debts

- **Hermes** — SOUL.md / skills folder / config layout
- **ElizaOS** — providers-as-sensors, actions, evaluators-as-reflection, plugin registry
- **Generative Agents (Stanford)** — sense → reflect → plan → act → memory-stream
- **MemGPT / Letta** — tiered memory + scheduled compaction
- **Pi** — TS agent loop shape, MCP wiring (for future coding delegate)
- **Claude Code / Claude Agent SDK** — the multi-step coding loop we delegate to
- **Vercel Eve** — mission-scoped agent-per-process shape, streaming tool calls, clean per-run event log

## Status

Early scaffolding. Runtime skeleton + first coworker (Alex, Linear triage, dry-run).

## Run

```
node --experimental-strip-types --no-warnings src/index.ts alex-triage
```

## Layout

```
src/
  runtime/     tick, sensors, deliberate, actions, memory, boundaries, hygiene, log
  tools/       linear, slack, gdocs, ...
  delegates/   coder (future: pi / claude code)
coworkers/
  alex-triage/
    role/      ROLE, RESPONSIBILITIES, AUTHORITY, BOUNDARIES, RITUALS, RELATIONSHIPS, TOOLS
    state/     sqlite: events, memory, promises, resources
templates/     systemd unit template
bin/           new-coworker generator
```

MIT.
