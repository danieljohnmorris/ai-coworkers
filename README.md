# ai-coworkers

[![ci](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml/badge.svg)](https://github.com/danieljohnmorris/ai-coworkers/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-97.9%25-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/badge/tests-782-brightgreen)](#tests)

**A daemon with a job description.** There is no chat window here. Nobody
talks to a coworker, and nobody watches it work. It wakes on a clock or a
webhook, reads its sensors, and acts inside a role you wrote in markdown, with
its own responsibilities and boundaries. When it needs a human, it asks and
keeps working.

Most "AI coworkers" are a chat interface with tools behind it. This is the
other thing: a long-running process that holds a job.

**Small enough to read cover-to-cover.** ~7.5k lines of TypeScript. Every
non-trivial choice has an ADR under [`docs/adr/`](docs/adr/). `cat` a
coworker's state directory to see exactly what it knows about the world — no
query language, no Postgres, no admin panel. MIT-licensed. If a team
platform with Slack + web UI + multiplayer channels + Postgres is what you
actually need, [QM](https://github.com/yc-software/qm) is the right tool.
[docs/comparison.md](docs/comparison.md) has the honest read.

<table>
<tr><td><b>Does a job, not a task</b></td><td>Ships with seven roles: triage engineer, PR reviewer, project manager, scribe, incident RCA, changelog, monitoring. Copy one, edit the markdown, restart.</td></tr>
<tr><td><b>Configured like a hire</b></td><td>A coworker is a directory: <code>ROLE.md</code>, <code>RESPONSIBILITIES.md</code>, <code>AUTHORITY.md</code>, <code>BOUNDARIES.md</code>, <code>RITUALS.md</code>, <code>RELATIONSHIPS.md</code>. No YAML, no code changes to tune behaviour. <code>bin/aicw new-interview</code> writes them from a JD-style Q&A.</td></tr>
<tr><td><b>Can't touch what you didn't allow</b></td><td>Every action is checked against <code>BOUNDARIES.md</code> before it executes. Writes are dry-run until you pass <code>--live</code>, so you can watch one work for a day before it can change anything.</td></tr>
<tr><td><b>Asks instead of guessing</b></td><td>A single <code>ask</code> tool routes to you, a peer coworker, Slack, or a GitHub PR. Questions to you persist in <code>state/questions.md</code> until answered, so nothing quietly gets invented.</td></tr>
<tr><td><b>Cheap while nothing happens</b></td><td>A tick that finds nothing new returns before any model is called, triage included. The interval backs off while quiet and resets on a webhook or <code>/wake</code>.</td></tr>
<tr><td><b>Runs your existing agent artifacts</b></td><td>MCP servers via one env var, Hermes / OpenClaw skills from <code>~/.hermes/skills/</code>, Vercel Eve <code>agent/</code> folders, and coding work delegated to any ACP agent (Goose, Codex, Claude Code).</td></tr>
<tr><td><b>Remembers across restarts</b></td><td>Six memory tiers (working, episodic, semantic, entity, procedural, reflective) in local SQLite with FTS5, plus per-person and per-project notes it maintains itself. Rollups link to the raw events they distilled; <code>memory.walk</code> drills the ladder with a refusal path instead of guessing. Recall needs no network. For a shared brain across your chat clients, point <code>MCP_SERVERS</code> at <a href="https://github.com/NateBJones-Projects/OB1">OB1</a>.</td></tr>
</table>

**Two ways in.** To run a coworker, start with the
[builder guide](docs/coworker-builder-guide.md) and [Install](#install) below.
To change the harness itself, read [CONTRIBUTING.md](CONTRIBUTING.md) and the
ADRs in [`docs/adr/`](docs/adr/).

**Small harness, meant to be forked.** Inspired by the Pi CLI philosophy of shipping a compact, readable runtime rather than a framework: ~7.8k lines you can adopt, fork, and adapt to your team's shape without fighting an opinionated abstraction layer. Every design choice has an ADR (`docs/adr/`) so you can disagree and rewrite that piece in isolation.

Hermes and ElizaOS are chat-native: you talk, they act, you watch. CrewAI
orchestrates tasks you hand it. Rowboat and Anton are desktop coworkers you
converse with. ai-coworkers has no conversation to be in. It models **roles
with hard boundaries**, defaults to **dry-run**, and **escalates to a human
inbox** instead of guessing. Full comparison: [docs/comparison.md](docs/comparison.md).

| LOC | tests | coverage | adapters | memory tiers |
|---|---|---|---|---|
| ~8k | 782 | 97.9% lines · 95.9% statements · 91.2% branches | MCP · Hermes · Eve · ACP · native | working · episodic · semantic · entity · procedural · reflective |

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
[09:14:13] alex-triage [LIVE] → mcp.linear.create_comment: {"issueId":"e6ce...",
                       "body":"Which browser were you on?"}
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

Full walkthrough: [AGENTS.md](AGENTS.md) · [builder guide](docs/coworker-builder-guide.md) · [webhooks](docs/webhooks.md)

```bash
cp -r examples/generic-triage coworkers/my-triage   # or: bin/aicw new <name> --wizard
bin/aicw slack my-triage && bin/aicw verify-slack my-triage
npm run coworker my-triage                          # dry-run
npm run coworker my-triage -- --live                # once you trust it
```

Templates: `generic-triage`, `pr-reviewer`, `project-manager`, `scribe`, `trace`, `log`, `watchtower`. `bin/aicw new-interview <name>` writes role docs from a JD-style Q&A instead.

Linear has no setup script; it wires through its remote MCP server (OAuth 2.1). Add the server to `coworkers/<name>/.env` and the first tick opens a browser to consent. See [AGENTS.md](AGENTS.md#linear) and [docs/dedicated-linear-user.md](docs/dedicated-linear-user.md).

| Env var | Does what |
|---|---|
| `OLLAMA_API_KEY` | Required. Or any OpenAI-compatible endpoint. |
| `COWORKER_MODEL` | Main model. Defaults to `gemma4:cloud`. |
| `TRIAGE_MODEL` | Optional cheap-first preflight before the expensive prompt. |
| `MEMORY_PROMOTIONS` | `confident` (default) or `gated`: hold every reflect promotion for `bin/aicw memory-approve` before it touches MEMORY.md. |
| `WAKE_PORT` / `WAKE_SECRET` | Wake server for webhooks. Declare hooks in `role/WEBHOOKS.json`; verifiers are `hmac-sha256`, `github-sha256`, `slack-v0`, `none`. See [docs/webhooks.md](docs/webhooks.md). |
| `WAKE_MODE` | `tick`, `webhook` or `both` (default). See below. |
| `MCP_SERVERS` | JSON array of MCP servers. Each tool registers as `mcp.<name>.<tool>`. |
| `METRICS_ENABLED=1` | Prometheus `/metrics` on the wake port. |

Per-coworker `.env` files at `coworkers/<name>/.env` override the shell env.

Wake mode decides what can wake a coworker:

| mode | wakes on | pick it when |
|---|---|---|
| `tick` | the clock only, every `TICK_INTERVAL_MS` (default 5 min, backing off to 30 min while quiet) | nothing can reach you from outside: behind NAT, no tunnel |
| `webhook` | inbound webhooks, plus one tick every 24h | you trust your webhook coverage and want the fewest wakes. The 24h tick is a safety net, so if delivery breaks you notice in a day rather than never |
| `both` (default) | either | you want webhooks for speed and the clock to catch whatever they miss |

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
    memory-map.md      the memory ladder as one readable page (regenerated weekly)
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

**Memory review.** Approve a queued promotion, or strike something already remembered:
```bash
bin/aicw memory-approve alex-triage
bin/aicw memory-strike alex-triage "hardcoded model name"
```
Promotions queue in `state/memory-map.md`; a strike snapshots the previous MEMORY.md first.

**Coworker → coworker / Slack / GitHub.** One `ask` tool with
`to="manager"` · `to="coworker:sam"` · `to="slack:#triage"` ·
`to="slack:@userId"` · `to="github:owner/repo#123"`. The channel is
contextual, so the coworker picks the surface that fits.

Linear is the exception: `ask` no longer routes `linear:`, since the native
Linear tool was replaced by Linear's remote MCP server. A coworker comments on
a ticket with `mcp.linear.create_comment` directly. See
[`src/tools/ask.ts`](src/tools/ask.ts).

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

**Pairs with the tools you already run.** A coworker is the unattended half;
these are the human-facing halves it plugs into:

- [Hermes](https://github.com/NousResearch/hermes-agent) — its skills load
  directly from `~/.hermes/skills/`, and `bin/aicw gmail` reuses its Google
  OAuth plumbing. `bin/import-hermes.sh` migrates an existing setup.
- [OB1 / Open Brain](https://github.com/NateBJones-Projects/OB1) — a shared
  memory layer behind an MCP server. Add it to `MCP_SERVERS` and a coworker
  reads and writes the same brain your chat clients use, as
  `mcp.<name>.capture_thought` / `search_thoughts`. No code change.
- [Rowboat](https://github.com/rowboatlabs/rowboat) and desktop coworkers
  like it — chat-first, human present. Run one of those for conversation and
  an ai-coworker for the job nobody watches. Different halves of the day.
- Claude Code / [Goose](https://github.com/block/goose) / Codex — a coworker
  hands them coding work over ACP via `code.delegate`.

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

| Doc | What's covered |
|---|---|
| [Coworker builder guide](docs/coworker-builder-guide.md) | Writing role docs, the non-technical path |
| [Tool cookbook](docs/tool-cookbook.md) | Adding a native tool, `ToolDef` shape |
| [Dedicated Linear user](docs/dedicated-linear-user.md) | Giving a coworker its own Linear seat |
| [Webhooks](docs/webhooks.md) | `WEBHOOKS.json` schema, signature verifiers, tunnels |
| [systemd](docs/systemd.md) | Running a fleet as units, shutdown behaviour |
| [Multi-machine](docs/multi-machine.md) | Coworkers across more than one box |
| [Comparison](docs/comparison.md) | vs Buzz, Hermes, OpenClaw, Eve, ElizaOS, OpenSRE, Anthropic MA, CrewAI, LangGraph |
| [ADRs](docs/adr/) | One per design decision, including the [CoALA memory taxonomy](docs/adr/0001-coala-memory-taxonomy.md) |
| [Migration](docs/migration.md) · [Releases](docs/release-process.md) | Upgrading, and how versions are cut |

**Design lineage.** Pi CLI (small forkable harness > opinionated framework),
Hermes/OpenClaw (SOUL/USER/MEMORY files, skills, dreams), ElizaOS
(providers·actions·evaluators), Generative Agents (Stanford), MemGPT/Letta
(tiered memory), Vercel Eve (filesystem-first), Claude Code (multi-tool turns),
[CoALA](https://arxiv.org/abs/2309.02427) (memory taxonomy).

---

## Tests

```bash
npm test              # 782 tests, ~3s
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
