# ai-coworkers

Long-running AI coworkers with **roles**, **boundaries**, and a **tick loop**.
Not one-shot task agents — persistent processes that decide when *not* to act.

Unlike Hermes / ElizaOS (single-agent, chat-native) or CrewAI (task
orchestration), ai-coworkers models **roles with hard boundaries**, defaults
to **dry-run**, and **escalates to a human inbox** instead of guessing.

MIT, TypeScript, Node ≥ 22, ~3 kLOC, 170 tests.

---

## Install

```bash
git clone https://github.com/danieljohnmorris/ai-coworkers
cd ai-coworkers && npm install
```

Set two env vars in `.env`:

```
OLLAMA_API_KEY=...    # or any OpenAI-compatible endpoint
LINEAR_API_KEY=...    # optional — only if you want the Linear coworker
```

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

The `role/` docs are the whole config. Edit markdown → restart → new behavior.
No YAML, no code changes for behavior tuning.

Run it:

```bash
node --experimental-strip-types --no-warnings src/index.ts alex-triage
# Add --live to allow write actions to actually execute.
```

Default is **dry-run**. Every write returns `{dryRun: true, would: {...}}` so
you can watch the coworker for a day before granting it live access.

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

The `💭` lines are the coworker's private thoughts — a running notebook that
threads across ticks. The `→` lines are actions. Both interleave in one file
the human can skim.

---

## The tick loop

Each coworker is a long-running process that repeats:

1. **Sense** — read-only sensors (Linear, GitHub, Slack, self-status). Cached.
2. **Perceive** — assemble world-state, tempo (self-awareness), budget usage, operator notes, own recent thoughts.
3. **Quiet gate** — if nothing changed *and* no work sensed *and* no ritual/promise due, skip the LLM call entirely. Zero cost.
4. **Deliberate + chain** — model returns `{thoughts, action, reason, pace}`. Multiple tool calls per tick (Hermes/Eliza-style), until it says `noop "done"` or hits `MAX_TOOLS_PER_TICK`.
5. **Boundaries** — every action checked against `BOUNDARIES.md` before executing.
6. **Record** — structured event log + narrative `highlights.log` for humans + `MEMORY.md` for the coworker.
7. **Adaptive interval** — after quiet/noop ticks, sleep doubles up to a cap. Any activity or `/wake` resets. Model may set `pace: faster/slower` to override.

Details: [docs/tick-loop.md](docs/tick-loop.md) (TODO).

---

## Boundaries + dry-run

Every action is checked against the coworker's own `BOUNDARIES.md` before it
runs. Boundaries look like:

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

Rejected calls log `boundary.block` events (visible in `highlights.log`) and
never reach the target system. Dry-run is on until you pass `--live`, and
individual coworkers can be promoted independently.

---

## Humans ↔ coworker

**You → coworker** (leave a note that surfaces in the next tick's prompt):

```bash
bin/note-to.sh alex-triage "Prioritise ILO parser bugs today"
```

**Coworker → you** (persistent question log they see until answered):

```
Alex called `ask` with to="manager": "Is `perf` the right label for
memory-usage tickets, or should we split into `perf-mem` and `perf-cpu`?"
```

Answer in-place:

```bash
bin/answer.sh alex-triage "Keep it as perf, don't split yet."
```

**Coworker → coworker** (peer inbox): `ask` with `to="coworker:sam"`.
**Coworker → Slack / Linear / GitHub**: `ask` with `to="slack:#triage"` /
`to="linear:ILO-42"` / `to="github:owner/repo#123"`. The channel of
reply is contextual — the coworker picks the surface that fits.

---

## Adapters

| Ecosystem | How | File |
|---|---|---|
| **MCP servers** | `MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'` | `src/adapters/mcp.ts` |
| **Hermes / OpenClaw / Anthropic skills** | Drop under `~/.hermes/skills/`; add name to `ACTIVE_SKILLS=` to inline the full body | `src/adapters/hermes.ts` |
| **Vercel Eve `agent/` folder** | Point loader at Eve-shaped directory | `src/adapters/eve.ts` |
| **Native tools** | New `src/tools/<name>.ts` exporting `ToolDef[]` | `src/tools/linear.ts` for reference |

More: [docs/webhooks.md](docs/webhooks.md), [docs/systemd.md](docs/systemd.md).

---

## Coworker templates

Ready to `cp -r examples/<name> coworkers/<yourname>`:

- **generic-triage** — Linear triage engineer
- **pr-reviewer** — reviews open PRs on a set of GitHub repos
- **project-manager** — project health summaries, aging tickets

Generate from scratch:
```bash
bin/new-coworker.sh <name>              # blank template
bin/new-coworker-interview.sh <name>    # JD-style Q&A → writes role docs
```

---

## Operating a coworker

```bash
tail -f coworkers/<name>/state/highlights.log   # actions + thoughts + escalations
tail -f coworkers/<name>/state/stream.log       # everything, one line per tick
sqlite3 coworkers/<name>/state/events.db "SELECT ts, kind, substr(payload,1,150) \
  FROM events ORDER BY id DESC LIMIT 20"
```

Fleet dashboard for multiple coworkers:
```bash
node --experimental-strip-types src/dashboard.ts
# http://localhost:7777
```

systemd deployment: [docs/systemd.md](docs/systemd.md).

---

## Design lineage

Ideas borrowed from:

- **Hermes / OpenClaw** — `SOUL.md`/`USER.md`/`MEMORY.md` file convention, skills as procedural memory, dreaming ritual
- **ElizaOS** — providers-as-sensors, actions, evaluators-as-reflection
- **Generative Agents (Stanford)** — sense → reflect → plan → act → memory stream
- **MemGPT / Letta** — tiered memory, scheduled compaction
- **Vercel Eve** — filesystem-first configuration, `agent/` layout
- **Claude Code / Pi** — multi-step tool-use loops within a turn
- **CoALA (arXiv:2309.02427)** — working / episodic / semantic / entity / procedural / reflective memory taxonomy

CoALA vocabulary maps to modules in [`docs/adr/0001-coala-memory-taxonomy.md`](docs/adr/0001-coala-memory-taxonomy.md).

---

## Tests

```bash
npm test              # 170 tests
npm run test:cov      # coverage report (90%+ on lines/statements/functions)
```

Fake LLM + fake API fixtures in `test/fixtures.ts` let you exercise the tick
pipeline without touching real services.

---

## Status

Early. Runtime is stable and battle-tested against real Linear. Coding
coworker (`code.delegate`) is scaffolded but not yet wired to a real coding
harness. See open tickets: [linear.app/ilo-lang/team/AIC](https://linear.app/ilo-lang/team/AIC).

MIT.
