# ai-coworkers

[![ci](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml/badge.svg)](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-97.8%25-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/badge/tests-311-brightgreen)](#tests)

Long-running AI coworkers with **roles**, **boundaries**, and a **tick loop**.
Not one-shot task agents — persistent processes that decide when *not* to act.

**Runs your existing agent artifacts.** Point ai-coworkers at your Claude Code / OpenClaw / NanoClaw SOUL.md, Hermes skills, or Vercel Eve `agent/` folder — the adapters load them in-place. Delegate coding work to any [ACP](https://agentclientprotocol.com)-conformant agent (Goose, Codex, Claude Code) via `code.delegate`. Expose any [MCP](https://modelcontextprotocol.io) server through a coworker with one env var.

Unlike Hermes / ElizaOS (single-agent, chat-native) or CrewAI (task
orchestration), ai-coworkers models **roles with hard boundaries**, defaults
to **dry-run**, and **escalates to a human inbox** instead of guessing.

| LOC | tests | coverage | adapters | memory tiers |
|---|---|---|---|---|
| ~4.6k | 311 | 97%+ | MCP · Hermes · Eve · ACP · native | working · episodic · semantic · entity · procedural · reflective |

> _(TODO: 15-sec asciinema of a coworker deciding not to act — the whole thesis in one clip.)_

---

## Install

```bash
git clone https://github.com/danieljohnmorris/ai-coworkers
cd ai-coworkers && npm install
```

Two env vars in `.env`:

```
OLLAMA_API_KEY=...    # or any OpenAI-compatible endpoint
COWORKER_MODEL=...    # optional — main model, defaults to gemma4:cloud
TRIAGE_MODEL=...      # optional — cheap-first preflight (AIC-47); when
                      #   set, every tick asks this small model "act or
                      #   skip?" before spending the expensive prompt
LINEAR_API_KEY=...    # optional — only the Linear coworker needs it
```

Run it:

```bash
node --experimental-strip-types --no-warnings src/index.ts alex-triage
# add --live to allow write actions to actually execute
```

Default is **dry-run**. Every write returns `{dryRun: true, would: {...}}` so
you can watch a coworker for a day before granting live access.

---

## Watch it think

Real excerpt from `highlights.log`:

```
[22:57:51] 📬 note from manager: The linear.set_labels tool is fixed.
                                Please retry AIC-36.
[22:57:54] 💭 Dan confirmed linear.set_labels is fixed. AIC-36 (webhook
             adapter) needs 'Feature' label. I have the UUID and label ID
             from previous failed attempts. Retrying now.
[22:57:54] → linear.set_labels: {"issueId":"e6ce...","labelIds":["98d9..."]}
[22:57:56] 💭 AIC-36 labeled 'Feature' successfully. Backlog catch-up
             continues, but this specific task is done.
```

`💭` lines are the coworker's private thoughts — a running notebook that
threads across ticks. `→` lines are actions. Both interleave in one file a
human can skim.

---

## The tick loop

```
    ┌──────────────────────────────────────────────────────────────┐
    │                                                              │
    ▼                                                              │
  budget → sense → perceive → [quiet gate] ─── skip ──────► sleep ─┘
                                   │                          ▲
                                   ▼ (something to do)        │
                              deliberate ─── noop ────────────┤
                                   │                          │
                                   ▼ (chosen tool)            │
                              boundaries ─── block ───────────┤
                                   │                          │
                                   ▼                          │
                                 act ──── loop up to N tools ─┤
                                   │                          │
                                   ▼                          │
                              hygiene · rituals · record ─────┘
```

- **Sense** — read-only sensors (Linear, GitHub, Slack, self-status), cached.
- **Perceive** — world-state + tempo + budget + operator notes + own recent thoughts.
- **Quiet gate** — nothing changed, no work, no ritual/promise due → skip the LLM. Zero cost.
- **Deliberate** — model returns `{thoughts, action, reason, pace}`, may chain up to `MAX_TOOLS_PER_TICK`.
- **Boundaries** — every action checked against `BOUNDARIES.md` before execute.
- **Adaptive interval** — quiet/noop ticks double the sleep up to a cap; activity or `/wake` resets. Model may set `pace: faster/slower`.

---

## A coworker in one directory

```
coworkers/alex-triage/
  role/
    ROLE.md            who they are, working style
    RESPONSIBILITIES.md  what they own
    AUTHORITY.md       decide alone vs escalate
    BOUNDARIES.md      hard "must not touch" + resource caps
    RITUALS.md         recurring behaviors + tempo targets
    WORKSPACE.md       stable facts about the world
    TOOLS.md           which tools they may use
    RELATIONSHIPS.md   who they work with
  state/
    events.db          structured log (SQLite + FTS5)
    memory/MEMORY.md   semantic memory (2 KB cap)
    entities/          per-person + per-project notes
    inbox.md           notes from the human operator
    questions.md       questions the coworker is asking back
    stream.log         everything, chronological
    highlights.log     actions + thoughts + escalations only
```

Edit markdown → restart → new behavior. No YAML, no code changes for tuning.

---

## Boundaries + dry-run

```md
## Must not touch
- Any ticket in team CS (client data)
- Any code, repository, or PR
- Do not invent new labels — only apply labels that already exist

## Resource limits
- Max concurrent worktrees: 0
- Max LLM calls per day: 500
- Max LLM calls per 5h window: 200
```

Rejected calls log `boundary.block` (visible in `highlights.log`) and never
reach the target system. Coworkers get promoted to `--live` independently.

---

## Humans ↔ coworker

**You → coworker** — leaves a note that surfaces in the next tick's prompt:
```bash
bin/note-to.sh alex-triage "Prioritise ILO parser bugs today"
```

**Coworker → you** — persistent question log they see until answered:
```bash
bin/answer.sh alex-triage "Keep it as perf, don't split yet."
```

**Coworker → coworker / Slack / Linear / GitHub** — one `ask` tool with
`to="coworker:sam"` · `to="slack:#triage"` · `to="linear:ILO-42"` ·
`to="github:owner/repo#123"`. The channel is contextual — the coworker picks
the surface that fits.

---

## Adapters

| Ecosystem | How | File |
|---|---|---|
| **MCP servers** | `MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'` | `src/adapters/mcp.ts` |
| **Hermes / OpenClaw / Anthropic skills** | Drop under `~/.hermes/skills/`; add name to `ACTIVE_SKILLS=` to inline the full body | `src/adapters/hermes.ts` |
| **Vercel Eve `agent/` folder** | Point loader at Eve-shaped directory | `src/adapters/eve.ts` |
| **ACP coding agents** (Goose / Codex / Claude Code / …) | `ACP_AGENT_CMD="goose acp"` → coworker gets `code.delegate` tool | `src/adapters/acp.ts` |
| **Native tools** | New `src/tools/<name>.ts` exporting `ToolDef[]` | `src/tools/linear.ts` |

---

## Coworker templates

`cp -r examples/<name> coworkers/<yourname>`:

- **generic-triage** — Linear triage engineer
- **pr-reviewer** — reviews open PRs on watched GitHub repos
- **project-manager** — project health summaries, aging tickets
- **scribe** — keeps README + docs honest as the code changes
- **trace** — incident RCA: reads stack traces, walks git history, posts root-cause notes
- **log** — auto-changelog: updates CHANGELOG.md on every merge, drafts GitHub releases on every tag
- **watchtower** — monitoring: baselines operational signals + alerts on real anomalies (aggressive dedup)

From scratch:
```bash
bin/new-coworker.sh <name>              # blank template
bin/new-coworker-interview.sh <name>    # JD-style Q&A → writes role docs
```

---

## Operating

```bash
tail -f coworkers/<name>/state/highlights.log   # actions + thoughts + escalations
tail -f coworkers/<name>/state/stream.log       # everything
sqlite3 coworkers/<name>/state/events.db \
  "SELECT ts, kind, substr(payload,1,150) FROM events ORDER BY id DESC LIMIT 20"

node --experimental-strip-types src/dashboard.ts     # fleet view on :7777
```

---

## Docs

**Getting started**
- [Install & first coworker](docs/getting-started.md) (TODO)
- [Writing role docs](docs/role-docs.md) (TODO)

**Architecture**
- [Tick loop internals](docs/tick-loop.md) (TODO)
- [Memory taxonomy (CoALA mapping)](docs/adr/0001-coala-memory-taxonomy.md)
- [Boundary model](docs/boundaries.md) (TODO)

**Operations**
- [systemd deployment](docs/systemd.md)
- [Webhooks & external wakes](docs/webhooks.md)

**Design lineage** — Hermes/OpenClaw (SOUL/USER/MEMORY files, skills, dreams),
ElizaOS (providers·actions·evaluators), Generative Agents (Stanford),
MemGPT/Letta (tiered memory), Vercel Eve (filesystem-first), Claude Code / Pi
(multi-tool turns), [CoALA](https://arxiv.org/abs/2309.02427) (memory taxonomy).

---

## Tests

```bash
npm test              # 311 tests
npm run test:cov      # 97%+ lines · 96%+ functions · 87%+ branches
```

Fake LLM + fake API fixtures in `test/fixtures.ts` exercise the tick pipeline
without touching real services.

---

## Status

Early. Runtime is stable and battle-tested against real Linear. Coding
coworker (`code.delegate`) is scaffolded but not yet wired to a real coding
harness. Open work: [linear.app/ilo-lang/team/AIC](https://linear.app/ilo-lang/team/AIC).

MIT.
