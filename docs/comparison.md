# Comparison — ai-coworkers vs the rest

An honest, non-marketing read of where ai-coworkers sits in a crowded
space. Written for a visitor comparing frameworks; kept fair to each.
If we're beaten on a dimension, we say so.

Last refreshed: 2026-08-27 (Headlong added; matrix column pending AIC-130).

## The one-sentence positioning

**ai-coworkers** is a **small, filesystem-first, tick-driven** runtime
for **long-running AI agents with hard boundaries**. It optimises for
"the agent works safely while nobody's watching" — including *deciding
not to act* — rather than "the agent answers when spoken to."

If you want a **team platform** — agents alongside employees in Slack, per-scope
sandboxes, Postgres-backed, YC-backed distribution → **QM** (yc-software/qm).
If you want a desktop coworker you converse with → **Rowboat** or
**MindsHub's Anton** (both chat-first, with the human present and watching).
If you want a chat interface for agents → **Buzz**.
If you want the widest coding-agent ecosystem → **Claude Code / Codex / Goose** (we speak their protocol, ACP).
If you want dozens of pre-built domain skills → **Hermes** (we import them).
If you want incident response as a product → **OpenSRE**.
If you want an opinionated multi-agent orchestrator → **CrewAI / LangGraph**.
If you want an agent that thinks continuously and pings you when it decides to → **Headlong**.
If you want a **small forkable filesystem-first single-coworker runtime** that
gates every write against `BOUNDARIES.md`, escalates to a human inbox when
unsure, and can be read end-to-end in an afternoon → **ai-coworkers**.

## Feature matrix

Legend: ✓ present · ~ partial · — absent · ? not documented

| | ai-coworkers | QM | Buzz | Hermes | OpenClaw / NanoClaw | Vercel Eve | ElizaOS | OpenSRE | Anthropic MA | CrewAI | LangGraph |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Runtime shape** | tick loop | headless core + pluggable harness | chat/rooms | request/response | message-dispatch | request/response | event loop | alert-driven | scheduler + reactive | task DAG | graph traversal |
| **Decides when NOT to act** | ✓ quiet gate + adaptive backoff | — | — | — | — | — | — | — | ~ scheduler idle | — | — |
| **Filesystem-first config** | ✓ `role/*.md` | — (Postgres) | — (Nostr events) | ✓ SKILL.md files | ✓ SOUL.md / AGENTS.md | ✓ `agent/` folder | — (plugin registry) | ~ .env + Python | ~ config JSON | — (Python code) | — (Python code) |
| **Hard boundary regex + dry-run default** | ✓ | ~ Strict / Auto / Dangerous baseline modes | — (identity scopes) | — | ~ (NanoClaw containers) | — | — | — (deliberately, per AGENTS.md) | ~ tool permissions | — | — |
| **Multi-tier memory** | ✓ 6-tier (CoALA) | ~ per-scope | ~ event log | ~ MEMORY.md + skills | ~ 4-tier (SoulClaw fork) | ~ instructions.md | ~ providers | ~ session | ~ dreaming | ~ shared | ~ state graph |
| **Reflect / dreaming ritual** | ✓ weekly compact + citations | ? | — | ✓ | ~ | — | ~ evaluators | — | ✓ dreaming pass | — | — |
| **Human ↔ agent channels** | ✓ inbox + questions + reactions + signed notes | ✓ Slack + web UI + admin | ✓ chat rooms | ~ chat surfaces | ~ platform adapters | ~ HTTP/Slack channels | ~ | ~ Slack / PD / Telegram | ✓ | — | — |
| **Cross-framework artifact import** | ✓ Hermes / OpenClaw / Eve loaders | ✓ Pi / OpenCode / Codex / Claude Code as harness | — | — | — | — | — | — | — | — | — |
| **ACP (coding-agent) protocol** | ✓ client | ~ (via harness plugins) | ✓ (buzz-cli harness) | ✓ via skills | ~ | — | — | ✓ | — | — | — |
| **MCP tool protocol** | ✓ client | ✓ | ✓ | ✓ | ✓ | ~ | ~ | ✓ | ✓ | — | ~ |
| **Per-tool credential filtering** | ✓ `requiresCreds` | ✓ per-scope | ~ identity scopes | ~ | ~ | — | — | — | ? | — | — |
| **Secret redaction at persistence** | ✓ same list as pre-commit hook | ~ content-screening | ? | ? | ? | ? | ? | ~ PII masking | ? | ? | ? |
| **Reversible identifier masking pre-LLM** | ✓ opt-in `PII_MASK=1` | ? | — | — | — | — | — | ✓ (their original idea) | ? | — | — |
| **Subprocess sandbox for delegated agents** | ✓ bwrap / firejail | ✓ per-scope sandbox (first-class) | ? | ? | ✓ containers (NanoClaw) | — | — | ~ platform/sandbox/ | ? | — | — |
| **Rate-limit awareness per external API** | ✓ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| **Prometheus metrics endpoint** | ✓ | ? | ? | ? | ? | ? | ? | ~ opt-out PostHog | ? | ? | ? |
| **Scored benchmark of agent behaviour** | ✓ small (3 scenarios) | ? | — | — | — | — | — | ✓ big (tests/synthetic/) | ? | — | — |
| **Long-running-agent focus** | ✓ core thesis | ✓ per-scope background jobs | ~ | ~ | ~ | — | ~ | ✓ | ✓ | — | ~ |
| **Multi-agent per host** | ✓ one dir per coworker | ✓ multi-scope (person + room) | ✓ per identity | ~ | ✓ per agent group | ✓ per `agent/` | ✓ per plugin | — (single agent) | ✓ | ✓ multi-role crew | ✓ multi-node |
| **Multi-user collaboration surface** | — (per-coworker isolation) | ✓ channels / group messages / projects | ✓ (chat-native) | ~ | ~ | ~ | ~ | — | — | — | — |
| **Small forkable harness (Pi CLI philosophy)** | ✓ ~7.5k LOC | — (headless + plugins + Postgres) | — (Rust relay + Tauri desktop) | — (large) | ~ (NanoClaw is small; OpenClaw is 500k LOC) | ~ | — | ~ (Python monorepo) | — | — | — |
| **Primary language** | TypeScript / Node ≥22 | TypeScript / Node | Rust + TS | Python | Python + TS (Nano) | TypeScript | TypeScript | Python | ? | Python | Python |
| **License** | MIT | ? (check repo) | Apache 2.0 | Apache 2.0 | mix | ? | ? | ? | proprietary | MIT | MIT |
| **Backing / distribution** | solo | YC (12k+ ⭐) | Block (Square) | Nous Research | Anthropic-community forks | Vercel | ai16z community | community | Anthropic | community | LangChain Inc. |

## Per-framework honest read

### QM (Y Combinator)

**Shape:** TypeScript headless core + Postgres persistence. Employees each get
their own isolated per-scope workspace (memory, files, credentials,
permissions, background jobs, sandbox); collaboration also happens in
channels, group messages, and projects. Slack (in-process), web UI (Vite /
Lit), admin panel, and public portal all talk to the core over HTTP. The
agent-loop tier is pluggable — Pi, OpenCode, Codex, Claude Code can all be
the underlying harness. Baseline security modes: **Strict** / **Auto** /
**Dangerous**, tightenable per scope. All activity audits under the acting
user's identity.

**They win on:** distribution (YC backing, 12k+ ⭐), multi-user collaboration
surfaces built in (channels / group messages / projects), first-class Slack
+ web UX, per-scope sandbox as a core primitive, pluggable agent runtime
(you pick the harness), production-scale persistence (Postgres).

**We win on:** filesystem-first state (`cat state/entities/people/dan.md`
answers "what does this coworker know about Dan" without a query language —
ADR 0006). Finer-grained governance: `BOUNDARIES.md` + per-tool field
allowlist + dry-run default is more surgical than a three-way baseline
switch. Smaller: 7.5k LOC end-to-end, readable in an afternoon. No Postgres
required, no ops surface, no admin panel — one process per coworker on
whatever machine you have. MIT.

**When to pick which:** if you need an AI-employee platform for a real team
(multiplayer, Slack-native, sandboxes, admin story), pick **QM**. If you
need a single long-running coworker per human with tight boundaries and
human-readable state you can fork and read cover-to-cover, pick
**ai-coworkers**. They are not the same product; they don't compete
head-on.

**Also worth naming:** ai-coworkers' `hermes-governance` plugin
(`github.com/danieljohnmorris/hermes-governance`) ports our BOUNDARIES.md
enforcement into any Hermes install — including a QM deployment that uses
Hermes as its harness. Governance travels; you don't have to switch
runtimes to adopt one piece.

### Buzz (Block)

**Shape:** Nostr relay + Tauri desktop client. Every message / reaction /
workflow step / git event is a signed event in one log; agents get their
own keypair alongside humans. Ships `buzz-cli` with an ACP harness for
Goose / Codex / Claude Code.

**They win on:** cryptographic identity per agent (portable across
relays), chat-native UX, git-events-in-the-room ("branch as room"),
open-source Slack alternative.

**We win on:** boundary regex + dry-run + quiet gate. Buzz agents are
chat participants — they don't have a "run silently for hours making no
noise" mode.

**Read our:** [`ADR 0002`](adr/0002-acp-code-delegate.md) — we adopted
their ACP.

### Hermes (Nous Research)

**Shape:** Python skill-based agent runtime. 72+ SKILL.md-style skills
(email, google-workspace, github, apple, creative, research, dev).
Rich CLI, secret managers (Bitwarden / 1Password), Slack + WhatsApp +
Discord gateway plugins.

**They win on:** breadth of pre-built domain skills, agent-driven OAuth
walkthroughs (you tell the agent "set up Gmail" and it walks you
through GCP setup), secrets manager integration.

**We win on:** boundary layer + tick loop. Hermes has no equivalent to
`BOUNDARIES.md`; the interactive-shell planner is explicitly non-denying
per their AGENTS.md footguns ("do not reintroduce a planner denial").

**Read our:** [`src/adapters/hermes.ts`](../src/adapters/hermes.ts) — we
load every Hermes skill as procedural memory. `bin/setup-gmail.sh` +
`bin/setup-slack.sh` wrap their setup CLIs.

### Headlong (Laude Institute)

**Shape:** Bash microharness (~10k lines) whose agent never sleeps. A Thinker
loop generates the next thought, `shellm` (a recursive language model in Bash)
executes bash blocks as the entire tool system, every run schedules its own
next wake-up, and all humans share one thought stream over Slack/Telegram.
Trajectory is a DAG of jsonl files; their progressive-resolution memory design
is published but not yet implemented.

**They win on:** persistent agency as the default. The agent sets its own
priorities and has produced unrequested, verified work — their Audel agent
found and fixed an unwired recall process over 48 minutes, merged from the
agent's own fork (their post, commit 80cbb1e). Agent self-modification of its
own harness, and a team-presence feel no per-user-session harness has.

**We win on:** the quiet gate and boundaries. Headlong backs off when idle but
never skips the model call ($1-2/hr reported); their own postmortem lists
three accidental self-service-stops and a guard that over-matched neighbouring
agents — failure classes our `BOUNDARIES.md` pre-execute checks and dry-run
default exist to prevent. Priorities: theirs are agent-invented, ours are role
docs a human writes.

**Read our:** [ADR 0008](adr/0008-progressive-resolution-memory.md) — we
adopt their ladder design on SQLite (AIC-127/128) and cut monologue ticks.

### OpenClaw / NanoClaw / SoulClaw

**Shape:** OpenClaw = large agent monorepo (~500k LOC per README). NanoClaw
= container-isolated lightweight fork ("understandability over features").
SoulClaw = memory-tiered fork with drift detection.

**They win on:** container isolation as the primitive (NanoClaw's whole
model), skills marketplace (ClawHub), forkability as an explicit design
value (NanoClaw again).

**We win on:** tick loop, hard boundaries, filesystem-first config.
NanoClaw is closer to our shape than either parent.

**Read our:** [`ADR 0003`](adr/0003-container-isolation.md) — we ship
subprocess sandboxing (bwrap/firejail); per-tool container isolation is
deferred.

### Vercel Eve

**Shape:** Filesystem-first agent framework with a canonical `agent/`
layout (`instructions.md`, `tools/`, `skills/`, `channels/`,
`schedules/`).

**They win on:** clean per-agent folder structure with `channels/` +
`schedules/` as first-class primitives.

**We win on:** tick loop, boundaries, multi-tier memory. Eve is a
per-request agent framework; ai-coworkers is a persistent-process one.

**Read our:** [`src/adapters/eve.ts`](../src/adapters/eve.ts) — we
surface Eve tool names as procedural memory (executable-adapter gap
noted in the source).

### ElizaOS

**Shape:** Four-primitive plugin model (actions / providers / evaluators
/ services). Bootable OS variants (Linux, Android), on-device Eliza-1 /
Gemma model family, non-custodial wallet integration.

**They win on:** genuine four-primitive vocabulary (we're missing
evaluators + services), on-device model story, wallet story.

**We win on:** tick loop, boundaries, filesystem-first. Eliza treats
each agent as a persistent character; we treat each as a bounded
worker.

**Read our:** [`ADR 0005`](adr/0005-evaluators-services.md) — we've
designed evaluators + services borrowing from ElizaOS's vocabulary
and staged them for implementation.

### OpenSRE (Tracer-Cloud)

**Shape:** Python SRE agent. Alert-driven; on alert, fetches context
(logs / metrics / traces / deploys), masks PII, runs a tool-calling
loop, generates an investigation report. 60+ integrations pre-wired.
Scored synthetic RCA suites.

**They win on:** breadth of observability integrations, scored RL-eval
scenarios, reversible identifier masking (we adopted this — see
[`src/runtime/pii_mask.ts`](../src/runtime/pii_mask.ts)).

**We win on:** deliberate boundary + dry-run model. Their AGENTS.md
explicitly forbids reintroducing a planner denial: "the interactive-
shell action planner never denies a turn." That's a different safety
philosophy.

**Read our:** [Watchtower template](../examples/watchtower/role/) — our
SRE-role coworker is a subset of what OpenSRE does, wrapped in our
boundary + tempo model.

### Anthropic Managed Agents

**Shape:** Hosted agent runtime on top of the Claude Agent SDK.
Scheduler + dreaming (like our reflect) + rubric-based outcome grading
(we've adopted the concept via `test/evals/bench.mjs`).

**They win on:** hosted management, rubric grading, deep integration
with Claude models.

**We win on:** self-hostable, adapter to any OpenAI-compatible LLM, one
directory per coworker, no vendor lock.

**Read our:** [`test/evals/bench.mjs`](../test/evals/bench.mjs) —
rubric-graded benchmark harness inspired by their pattern.

### CrewAI

**Shape:** Multi-agent role orchestration. Python. Focus on
"crews" (teams of agents with different roles collaborating on a
task).

**They win on:** multi-agent-per-task shape, wide adoption, Python
ecosystem.

**We win on:** long-running-per-role vs task-crews. CrewAI runs when
you invoke it; ai-coworkers runs continuously. Different problem.

### LangGraph

**Shape:** Graph-based agent orchestration. Python. Focus on
"nodes" (agents) and "edges" (state transitions).

**They win on:** explicit state-machine model for complex flows, wide
adoption, LangChain ecosystem.

**We win on:** we don't force a graph. The tick loop + boundaries do
what a state machine would express, without you having to write one.

## Dimensions where ai-coworkers is genuinely alone (as far as we've found)

- Regex-based `BOUNDARIES.md` pre-execute checks against every tool call
- `role.audit` ritual — treats the config file itself as an untrusted
  mutable surface + escalates on drift
- Six-tier memory taxonomy grounded in CoALA + event-ID provenance
  (`[ev:...]` citations walkable via `bin/why.sh`)
- Cursor-based one-time presentation of inbox notes + reactions (both
  seen once, then marked read — humans can leave feedback without it
  dominating perception forever)
- Quiet gate + adaptive tempo — deciding *not to act*
- Cross-framework import scripts (Hermes / OpenClaw / Eve → ai-coworker)

## Dimensions where we're behind

- **Buzz** — chat-native UX, cryptographic identity, cross-org / cross-
  machine event log
- **Hermes** — breadth of pre-built domain skills, agent-driven OAuth
  walkthroughs (we wrap theirs; we don't yet author our own)
- **Headlong** — persistent agency as a default (agent-set priorities,
  unrequested verified work), agent self-modification of its own harness,
  single shared thought stream as team presence
- **NanoClaw** — container isolation as the default primitive (we have
  it opt-in only)
- **OpenSRE** — depth of observability integrations, size of scored
  benchmark suite
- **CrewAI / LangGraph** — multi-agent orchestration patterns

## When to pick us

You want a persistent worker that:

- Runs quietly, decides not to act more often than it acts
- Has hard limits you can read in a `BOUNDARIES.md` (not code, not YAML)
- Reuses whatever ecosystem tooling you already have (Hermes skills,
  MCP servers, ACP coding agents)
- Escalates to a human inbox when it's not sure
- You can fork in an afternoon (~6.5k lines of TypeScript, no build
  step) and adapt to your team's shape

## When to pick someone else

- Your primary UX is chat → **Buzz**
- You want a rich pre-built skills library and don't need boundaries →
  **Hermes**
- You want dedicated SRE incident-response tooling as a product →
  **OpenSRE**
- You want a multi-agent crew on a discrete task → **CrewAI**
- You want a graph-modelled agent flow → **LangGraph**

## Contributing to this doc

- **Found something wrong?** File a PR; be specific about what changed
  in the compared framework and cite a source (repo file, docs URL).
- **Framework missing?** Add a row + a paragraph, following the shape
  above.
- **Think we're wrong about ourselves?** File a PR — the goal here is
  honest positioning, not marketing.
