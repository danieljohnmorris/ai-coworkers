# ai-coworkers

[![ci](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml/badge.svg)](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-97.9%25-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/badge/tests-735-brightgreen)](#tests)

An AI coworker you leave running. It holds a **role**, works inside
**boundaries** you write in markdown, asks instead of guessing, and spends no
tokens on the ticks where nothing changed.

Nobody prompts it. It wakes on a clock or a webhook, and most of those wakes
stop before a model is involved.

**Two ways in.** If you want to run a coworker, start with
[docs/coworker-builder-guide.md](docs/coworker-builder-guide.md) and the
[Install](#install) section below. If you want to change the harness itself,
read [CONTRIBUTING.md](CONTRIBUTING.md) and the ADRs in [`docs/adr/`](docs/adr/).

[Install](#install) · [Setup](#setup) · [Watch it think](#watch-it-think) ·
[Tick loop](#the-tick-loop) · [Coworker layout](#a-coworker-in-one-directory) ·
[Boundaries](#boundaries--dry-run) · [Adapters](#adapters) ·
[Templates](#coworker-templates) · [Operating](#operating) · [Docs](#docs) ·
[Contributing](#contributing) · [Status](#status)

**Small harness, meant to be forked.** Inspired by the Pi CLI philosophy of shipping a compact, readable runtime rather than a framework: ~7.8k lines you can adopt, fork, and adapt to your team's shape without fighting an opinionated abstraction layer. Every design choice has an ADR (`docs/adr/`) so you can disagree and rewrite that piece in isolation.

**Runs your existing agent artifacts.** Point ai-coworkers at your Claude Code / OpenClaw / NanoClaw SOUL.md, Hermes skills, or Vercel Eve `agent/` folder, and the adapters load them in-place. Delegate coding work to any [ACP](https://agentclientprotocol.com)-conformant agent (Goose, Codex, Claude Code) via `code.delegate`. Expose any [MCP](https://modelcontextprotocol.io) server through a coworker with one env var.

Unlike Hermes / ElizaOS (single-agent, chat-native) or CrewAI (task
orchestration), ai-coworkers models **roles with hard boundaries**, defaults
to **dry-run**, and **escalates to a human inbox** instead of guessing.

| LOC | tests | coverage | adapters | memory tiers |
|---|---|---|---|---|
| ~7.8k | 735 | 97.9% lines · 95.9% statements · 91.2% branches | MCP · Hermes · Eve · ACP · native | working · episodic · semantic · entity · procedural · reflective |

### Most ticks never reach the model

The quiet gate is ordinary code, not a judgement call. It compares the world
to the last tick and returns before any model is asked anything:

```
[09:06:02] alex-triage tick →
[09:06:02] alex-triage quiet — nothing new for 240s, no LLM call
[09:06:02] alex-triage idle x3 — next tick in 480s
```

No tokens. Not a cheap model, not a short prompt: the gate returns at
[`src/runtime/tick.ts`](src/runtime/tick.ts) before either the triage model or
the main one is reached. Sensor polling still costs you API calls. The interval
doubles to a cap while nothing happens. A webhook, a new ticket or `/wake`
resets it:

```
[09:14:11] alex-triage activity resumed — interval reset to 60s
[09:14:13] alex-triage 💭 New bug report, no repro steps. Asking rather
                       than guessing at the browser.
[09:14:13] alex-triage [LIVE] → ask: {"to":"linear:TRIAGE-88","q":"Which browser?"}
```

The `💭` lines are the coworker's own reasoning. It asked rather than guessed
because [`BOUNDARIES.md`](examples/generic-triage/role/BOUNDARIES.md) does not
let it invent a label.

---

## Install

```bash
git clone https://github.com/danieljohnmorris/ai-coworkers
cd ai-coworkers && npm install
```

Two env vars in `.env`:

```
OLLAMA_API_KEY=...    # or any OpenAI-compatible endpoint
COWORKER_MODEL=...    # optional, main model, defaults to gemma4:cloud
TRIAGE_MODEL=...      # optional, cheap-first preflight; when set,
                      #   every tick asks this small model "act or
                      #   skip?" before spending the expensive prompt
METRICS_ENABLED=1     # optional, expose Prometheus /metrics on WAKE_PORT
```

Run it:

```bash
npm run coworker alex-triage
# add -- --live to allow write actions to actually execute
```

Default is **dry-run**. Every write returns `{dryRun: true, would: {...}}` so
you can watch a coworker for a day before granting live access.

---

## Setup

Full walkthrough: [AGENTS.md](AGENTS.md) · [docs/webhooks.md](docs/webhooks.md)

### 1. Env

Create `.env` at the repo root (gitignored):

```
OLLAMA_API_KEY=...          # or any OpenAI-compatible endpoint
COWORKER_MODEL=gemma4:cloud # optional; default shown
TRIAGE_MODEL=               # optional; cheap-first preflight
```

Per-coworker overrides go in `coworkers/<name>/.env` and win over the shell env.

### 2. Pick a template

```bash
cp -r examples/generic-triage coworkers/my-triage
```

Available: `generic-triage`, `pr-reviewer`, `project-manager`, `scribe`, `trace`, `log`, `watchtower`. Or scaffold from scratch with `bin/aicw new <name>` (blank) or `bin/aicw new-interview <name>` (JD-style Q&A). For a full guided setup (template, integrations and config) use `bin/aicw new <name> --wizard`. (The legacy [`bin/new-coworker.sh`](bin/new-coworker.sh) / [`bin/new-coworker-interview.sh`](bin/new-coworker-interview.sh) names still work via deprecated symlinks.)

### 3. Connect a service

Each script prompts for tokens and writes them to `coworkers/<name>/.env`:

```bash
bin/aicw slack  my-triage    &&  bin/aicw verify-slack  my-triage
bin/aicw gmail  my-triage    &&  bin/aicw verify-gmail  my-triage
```

Linear no longer has a setup script. It's wired via its remote MCP
server (OAuth 2.1). Add the server to `coworkers/<name>/.env` and let
the first tick open a browser to consent. See
[AGENTS.md](AGENTS.md#linear) and
[docs/dedicated-linear-user.md](docs/dedicated-linear-user.md).

### 4. Optional: webhooks (sub-second reactions)

Set `WAKE_PORT=7778` (and `WAKE_SECRET` for auth) in the coworker's `.env`, then declare inbound webhooks in `coworkers/<name>/role/WEBHOOKS.json`. Closed-set signature verifiers: `hmac-sha256`, `github-sha256`, `slack-v0`, `none`. See [docs/webhooks.md](docs/webhooks.md) for schema + tunnel setup.

Choose an activity mode via `WAKE_MODE`. It decides what can wake a coworker:
the clock, an inbound webhook, or both.

| mode | wakes on | pick it when |
|---|---|---|
| `tick` | the clock only, every `TICK_INTERVAL_MS` (default 5 min, backing off to 30 min while quiet) | nothing can reach you from outside: behind NAT, no tunnel |
| `webhook` | inbound webhooks, plus one tick every 24h | you trust your webhook coverage and want the fewest wakes. The 24h tick is a safety net, so if delivery breaks you notice in a day rather than never |
| `both` (default) | either | you want webhooks for speed and the clock to catch whatever they miss |

`both` costs nothing extra on a quiet system, because a tick that finds nothing
new stops at the quiet gate without calling a model.

### 5. Optional: MCP servers (extra tools)

One env var per fleet or per coworker:

```
MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'
```

Every listed tool registers as `mcp.<name>.<tool>`. See [`src/adapters/mcp.ts`](src/adapters/mcp.ts).

### 6. Optional: metrics

```
METRICS_ENABLED=1
```

Prometheus endpoint served on the wake port at `/metrics` (requires `WAKE_PORT` set).

### 7. Go live

Watch in dry-run for a day, then promote:

```bash
npm run coworker my-triage -- --live
```

For long-running deployment see [docs/systemd.md](docs/systemd.md).

---

## Watch it think

Excerpt from a real `highlights.log` (ticket ids anonymised):

```
[22:57:51] 📬 note from manager: The linear.set_labels tool is fixed.
                                Please retry TRIAGE-42.
[22:57:54] 💭 Manager confirmed linear.set_labels is fixed. TRIAGE-42
             (webhook adapter) needs 'Feature' label. I have the UUID
             and label ID from previous failed attempts. Retrying now.
[22:57:54] → linear.set_labels: {"issueId":"e6ce...","labelIds":["98d9..."]}
[22:57:56] 💭 TRIAGE-42 labeled 'Feature' successfully. Backlog catch-up
             continues, but this specific task is done.
```

`💭` lines are the coworker's private thoughts, a running notebook that
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

- **Sense**: read-only sensors (Linear, GitHub, Slack, self-status), cached.
- **Perceive**: world-state + tempo + budget + operator notes + own recent thoughts.
- **Quiet gate**: nothing changed, no work, no ritual/promise due → return before any model call, triage included. Sensor polling still costs API calls.
- **Deliberate**: model returns `{thoughts, action, reason, pace}`, may chain up to `MAX_TOOLS_PER_TICK`.
- **Boundaries**: every action checked against `BOUNDARIES.md` before execute.
- **Adaptive interval**: quiet/noop ticks double the sleep up to a cap; activity or `/wake` resets. Model may set `pace: faster/slower`.

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

Each coworker has its own `role/BOUNDARIES.md`. Below is an abridged one
from the triage template
([examples/generic-triage/role/BOUNDARIES.md](examples/generic-triage/role/BOUNDARIES.md),
which also gates individual Linear MCP write tools):

```md
## Must not touch
- Any ticket in team CS (client data)
- Any code, repository, or PR
- Do not invent new labels; only apply labels that already exist

## Resource limits
- Max concurrent worktrees: 0
- Max LLM calls per day: 500
- Max LLM calls per 5h window: 200
```

Rejected calls log `boundary.block` (visible in `highlights.log`) and never
reach the target system. Coworkers get promoted to `--live` independently.

---

## Humans ↔ coworker

**You → coworker.** Leaves a note that surfaces in the next tick's prompt:
```bash
bin/aicw note alex-triage "Prioritise ILO parser bugs today"
```

**Coworker → you.** A persistent question log they see until answered:
```bash
bin/aicw answer alex-triage "Keep it as perf, don't split yet."
```

**Coworker → coworker / Slack / Linear / GitHub.** One `ask` tool with
`to="coworker:sam"` · `to="slack:#triage"` · `to="linear:ILO-42"` ·
`to="github:owner/repo#123"`. The channel is contextual, so the coworker picks
the surface that fits.

---

## Adapters

| Ecosystem | How | File |
|---|---|---|
| **MCP servers** | `MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'` | [`src/adapters/mcp.ts`](src/adapters/mcp.ts) |
| **Hermes / OpenClaw / Anthropic skills** | Drop under `~/.hermes/skills/`; add name to `ACTIVE_SKILLS=` to inline the full body | [`src/adapters/hermes.ts`](src/adapters/hermes.ts) |
| **Vercel Eve `agent/` folder** | Point loader at Eve-shaped directory | [`src/adapters/eve.ts`](src/adapters/eve.ts) |
| **ACP coding agents** (Goose / Codex / Claude Code / …) | `ACP_AGENT_CMD="goose acp"` → coworker gets `code.delegate` tool | [`src/adapters/acp.ts`](src/adapters/acp.ts) |
| **Gmail + Google Workspace** (reuses Hermes) | `bin/aicw gmail <coworker>` → OAuth flow, token scoped per-coworker at `state/hermes-home/`; then `gmail.*` tools available | [`src/tools/gmail.ts`](src/tools/gmail.ts) |
| **Slack** | `bin/aicw slack <coworker>` → generates app manifest via `hermes slack manifest`, walks you through workspace install, prompts for tokens → written to `coworkers/<name>/.env` | [`src/tools/slack.ts`](src/tools/slack.ts) |
| **Linear** | Add Linear's remote MCP server (`https://mcp.linear.app/mcp`, OAuth 2.1 + DCR) to `MCP_SERVERS` in `coworkers/<name>/.env`; declare sensors in `role/SENSORS.json`. First tick opens a browser to consent. | [`src/adapters/mcp.ts`](src/adapters/mcp.ts) + [`examples/generic-triage/role/SENSORS.json`](examples/generic-triage/role/SENSORS.json) |
| **Native tools** | New `src/tools/<name>.ts` exporting `ToolDef[]` | [`src/tools/github.ts`](src/tools/github.ts) |

**Verify setup landed:**
```bash
bin/aicw verify-gmail <coworker>    # runs one 'in:inbox' read via Hermes google_api.py
bin/aicw verify-slack <coworker>    # calls Slack auth.test with the coworker's token
# For Linear: check stream.log for "mcp: connected linear (N tools)"
# and coworkers/<coworker>/state/mcp-tokens/linear.json existence.
```

---

## Coworker templates

`cp -r examples/<name> coworkers/<yourname>`:

- **generic-triage**: Linear triage engineer
- **pr-reviewer**: reviews open PRs on watched GitHub repos
- **project-manager**: project health summaries, aging tickets
- **scribe**: keeps README + docs honest as the code changes
- **trace**: incident RCA: reads stack traces, walks git history, posts root-cause notes
- **log**: auto-changelog: updates CHANGELOG.md on every merge, drafts GitHub releases on every tag
- **watchtower**: monitoring: baselines operational signals + alerts on real anomalies (aggressive dedup)

From scratch:
```bash
bin/aicw new <name>                     # blank template
bin/aicw new <name> --wizard            # guided: template + integrations + config
bin/aicw new-interview <name>           # JD-style Q&A → writes role docs
# (Legacy [`bin/new-coworker.sh`](bin/new-coworker.sh) / [`bin/new-coworker-interview.sh`](bin/new-coworker-interview.sh) still work as deprecated symlinks.)
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
- [Coworker builder guide](docs/coworker-builder-guide.md)
- [Tool cookbook](docs/tool-cookbook.md)
- [Dedicated Linear user](docs/dedicated-linear-user.md)

**Architecture**
- [Architecture decision records](docs/adr/)
- [Memory taxonomy (CoALA mapping)](docs/adr/0001-coala-memory-taxonomy.md)
- [Comparison with other harnesses](docs/comparison.md), vs Buzz, Hermes, OpenClaw, Eve, ElizaOS, OpenSRE, Anthropic MA, CrewAI, LangGraph

**Operations**
- [systemd deployment](docs/systemd.md)
- [Webhooks and external wakes](docs/webhooks.md)
- [Multi-machine fleets](docs/multi-machine.md)
- [Migration notes](docs/migration.md)
- [Release process](docs/release-process.md)

**Design lineage.** Pi CLI (small forkable harness > opinionated framework),
Hermes/OpenClaw (SOUL/USER/MEMORY files, skills, dreams), ElizaOS
(providers·actions·evaluators), Generative Agents (Stanford), MemGPT/Letta
(tiered memory), Vercel Eve (filesystem-first), Claude Code (multi-tool turns),
[CoALA](https://arxiv.org/abs/2309.02427) (memory taxonomy).

---

## Tests

```bash
npm test              # 735 tests, ~3s
npm run test:cov      # 97.9% lines · 95.9% statements · 97.5% functions · 91.2% branches
```

Fake LLM + fake API fixtures in [`test/fixtures.ts`](test/fixtures.ts) exercise the tick pipeline
without touching real services.

---

## Contributing

Issues and pull requests are welcome. Where to look first:

- [CONTRIBUTING.md](CONTRIBUTING.md), how to set up, test and open a PR
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md), how to report a vulnerability
- [`docs/adr/`](docs/adr/), one ADR per design decision. If you disagree with a
  choice, the ADR is where to argue with it

Run `npm test` before opening a PR. CI runs the same suite on Node 22.

---

## Status

Early. The runtime is stable and has been running against real Linear.
The coding coworker (`code.delegate`) is scaffolded but not yet wired to a
real coding harness. Open work: [GitHub Issues](../../issues).

Licensed under [MIT](LICENSE).
