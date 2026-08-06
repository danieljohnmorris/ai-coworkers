# ai-coworkers

[![ci](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml/badge.svg)](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-97.9%25-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/badge/tests-642-brightgreen)](#tests)

Long-running AI coworkers with **roles**, **boundaries**, and a **tick loop**.
Not one-shot task agents — persistent processes that decide when *not* to act.

**Small harness, meant to be forked.** Inspired by the Pi CLI philosophy of shipping a compact, readable runtime rather than a framework: ~7.6k lines you can adopt, fork, and adapt to your team's shape without fighting an opinionated abstraction layer. Every design choice has an ADR (`docs/adr/`) so you can disagree and rewrite that piece in isolation.

**Runs your existing agent artifacts.** Point ai-coworkers at your Claude Code / OpenClaw / NanoClaw SOUL.md, Hermes skills, or Vercel Eve `agent/` folder — the adapters load them in-place. Delegate coding work to any [ACP](https://agentclientprotocol.com)-conformant agent (Goose, Codex, Claude Code) via `code.delegate`. Expose any [MCP](https://modelcontextprotocol.io) server through a coworker with one env var.

Unlike Hermes / ElizaOS (single-agent, chat-native) or CrewAI (task
orchestration), ai-coworkers models **roles with hard boundaries**, defaults
to **dry-run**, and **escalates to a human inbox** instead of guessing.

| LOC | tests | coverage | adapters | memory tiers |
|---|---|---|---|---|
| ~7.6k | 642 | 97.9% lines · 95.9% statements · 91.1% branches | MCP · Hermes · Eve · ACP · native | working · episodic · semantic · entity · procedural · reflective |

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
TRIAGE_MODEL=...      # optional — cheap-first preflight; when set,
                      #   every tick asks this small model "act or
                      #   skip?" before spending the expensive prompt
METRICS_ENABLED=1     # optional — expose Prometheus /metrics on WAKE_PORT
```

Run it:

```bash
node --experimental-strip-types --no-warnings src/index.ts alex-triage
# add --live to allow write actions to actually execute
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

Available: `generic-triage`, `pr-reviewer`, `project-manager`, `scribe`, `trace`, `log`, `watchtower`. Or scaffold from scratch with `bin/new-coworker.sh <name>` (blank) or `bin/new-coworker-interview.sh <name>` (JD-style Q&A).

### 3. Connect a service

Each script prompts for tokens and writes them to `coworkers/<name>/.env`:

```bash
bin/setup-slack.sh  my-triage    &&  bin/verify-slack.sh  my-triage
bin/setup-gmail.sh  my-triage    &&  bin/verify-gmail.sh  my-triage
```

Linear no longer has a setup script — it's wired via its remote MCP
server (OAuth 2.1). Add the server to `coworkers/<name>/.env` and let
the first tick open a browser to consent. See
[AGENTS.md](AGENTS.md#linear) and
[docs/dedicated-linear-user.md](docs/dedicated-linear-user.md).

### 4. Optional: webhooks (sub-second reactions)

Set `WAKE_PORT=7778` (and `WAKE_SECRET` for auth) in the coworker's `.env`, then declare inbound webhooks in `coworkers/<name>/role/WEBHOOKS.json`. Closed-set signature verifiers: `hmac-sha256`, `github-sha256`, `slack-v0`, `none`. See [docs/webhooks.md](docs/webhooks.md) for schema + tunnel setup.

### 5. Optional: MCP servers (extra tools)

One env var per fleet or per coworker:

```
MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'
```

Every listed tool registers as `mcp.<name>.<tool>`. See `src/adapters/mcp.ts`.

### 6. Optional: metrics

```
METRICS_ENABLED=1
```

Prometheus endpoint served on the wake port at `/metrics` (requires `WAKE_PORT` set).

### 7. Go live

Watch in dry-run for a day, then promote:

```bash
node --experimental-strip-types --no-warnings src/index.ts my-triage --live
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
| **Gmail + Google Workspace** (reuses Hermes) | `bin/setup-gmail.sh <coworker>` → OAuth flow, token scoped per-coworker at `state/hermes-home/`; then `gmail.*` tools available | `src/tools/gmail.ts` |
| **Slack** | `bin/setup-slack.sh <coworker>` → generates app manifest via `hermes slack manifest`, walks you through workspace install, prompts for tokens → written to `coworkers/<name>/.env` | `src/tools/slack.ts` |
| **Linear** | Add Linear's remote MCP server (`https://mcp.linear.app/mcp`, OAuth 2.1 + DCR) to `MCP_SERVERS` in `coworkers/<name>/.env`; declare sensors in `role/SENSORS.json`. First tick opens a browser to consent. | `src/adapters/mcp.ts` + `examples/generic-triage/role/SENSORS.json` |
| **Native tools** | New `src/tools/<name>.ts` exporting `ToolDef[]` | `src/tools/github.ts` |

**Verify setup landed:**
```bash
bin/verify-gmail.sh <coworker>    # runs one 'in:inbox' read via Hermes google_api.py
bin/verify-slack.sh <coworker>    # calls Slack auth.test with the coworker's token
# For Linear: check stream.log for "mcp: connected linear (N tools)"
# and coworkers/<coworker>/state/mcp-tokens/linear.json existence.
```

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
- [Comparison with other harnesses](docs/comparison.md) — vs Buzz, Hermes, OpenClaw, Eve, ElizaOS, OpenSRE, Anthropic MA, CrewAI, LangGraph

**Operations**
- [systemd deployment](docs/systemd.md)
- [Webhooks & external wakes](docs/webhooks.md)

**Design lineage** — Pi CLI (small forkable harness > opinionated framework),
Hermes/OpenClaw (SOUL/USER/MEMORY files, skills, dreams), ElizaOS
(providers·actions·evaluators), Generative Agents (Stanford), MemGPT/Letta
(tiered memory), Vercel Eve (filesystem-first), Claude Code (multi-tool turns),
[CoALA](https://arxiv.org/abs/2309.02427) (memory taxonomy).

---

## Tests

```bash
npm test              # 642 tests, ~2s
npm run test:cov      # 97.9% lines · 95.9% statements · 97.6% functions · 91.1% branches
```

Fake LLM + fake API fixtures in `test/fixtures.ts` exercise the tick pipeline
without touching real services.

---

## Status

Early. Runtime is stable and battle-tested against real Linear. Coding
coworker (`code.delegate`) is scaffolded but not yet wired to a real coding
harness. Open work: [GitHub Issues](../../issues).

MIT.
