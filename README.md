# ai-coworkers

Long-running AI coworkers with roles, responsibilities, and boundaries — not one-shot
task agents. Each coworker is a persistent process with a persona, an area of
responsibility, sensors that read the world, actions gated by explicit authority,
a tick loop that decides whether to act, memory that grows and compacts, and a
hygiene layer that cleans up after itself.

## Design in one picture

```
role/ (markdown JD)  →  system prompt (cached)
                        ↓
sensors (read-only) → perception ─┐
action log ────────────────────────┼→ deliberate → act or noop → record
promises (future intents) ─────────┘                    ↓
                                                     boundaries
                                                     hygiene
                                                     event log + journal
```

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
