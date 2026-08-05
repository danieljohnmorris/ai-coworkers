# ai-coworkers

Long-running AI coworkers with roles, responsibilities, and boundaries — not one-shot
task agents. Each coworker is a persistent process with a persona, an area of
responsibility, sensors that read the world, actions gated by explicit authority,
a tick loop that decides whether to act, memory that grows and compacts, and a
hygiene layer that cleans up after itself.

## How a coworker works

Each coworker is a long-running process that repeats a **tick loop**:

1. **Sense.** Run every read-only sensor the coworker's role allows (new
   Linear issues, untagged backlog, Slack mentions, current time, its own
   resource usage). Results are per-sensor cached (5 min Linear, 1 min Slack,
   etc.) so we don't hammer APIs. A circuit breaker quarantines a sensor
   after N consecutive errors.
2. **Perceive.** Combine sensor output with recent action log, pending
   promises, memory rollups, **tempo self-awareness** (observed vs expected
   action rate), any **unread notes** from the operator, and the coworker's
   own **recent thoughts-to-self** into one "state of the world" snapshot.
3. **Quiet gate.** If perception hasn't changed *and* no sensor shows work
   *and* no promise/ritual is due *and* no operator note is waiting → skip
   deliberation entirely. Zero LLM cost. Truly idle coworkers are free.
4. **Deliberate + chain.** Feed the snapshot plus role docs (cached system
   prompt) to the LLM. Model returns `{thoughts, action, reason}`. If it
   chose an action, execute → feed result back → next step, up to
   `MAX_TOOLS_PER_TICK` (default 8) tool calls per tick, ending when the
   model says `noop "done"`. This is the Hermes/Eliza-style turn loop.
5. **Boundaries.** Every action is hard-checked against `BOUNDARIES.md`
   before executing. Doing nothing is a first-class choice.
6. **Record.** Every step goes to a structured event log (SQLite) plus two
   text logs: `stream.log` (everything) and `highlights.log` (actions,
   thoughts, blocks, errors, operator notes — the "what happened" narrative).
7. **Hygiene + rituals.** Sweep registered resources (worktrees, subprocs,
   scratch dirs) against per-role caps. Fire any due rituals — hourly health
   snapshot, daily journal, weekly reflective "dreaming" that distills
   learnings into MEMORY.md and prunes raw events.
8. **Adaptive interval.** After a quiet tick, next sleep doubles (up to
   `MAX_TICK_INTERVAL_MS`, default 30 min). Any real activity or external
   wake resets to base. Roles that need constant polling can declare
   `Cadence: constant` in `RITUALS.md`.

Ticks can be time-driven, event-driven via `POST /wake` (see
`docs/webhooks.md`), or immediate on human note via `bin/note-to.sh`.

## Coworker archetypes

Same runtime for both. Only the tools they declare differ.

- **Non-technical** (triage engineers, project managers, comms leads) —
  Linear, Slack, Gmail, Google Docs, Obsidian.
- **Technical** (PR reviewers, bug-fixers) — all of the above plus
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

Early scaffolding. Runtime skeleton, a sanitised `examples/generic-triage`
coworker, and a Linear tool (dry-run). Real coworker instances live under
`coworkers/` (gitignored — per-machine state).

## Create and run a coworker

```
cp -r examples/generic-triage coworkers/my-triager
$EDITOR coworkers/my-triager/role/*.md         # fill in WORKSPACE.md at minimum
export OLLAMA_API_KEY=... LINEAR_API_KEY=...   # or use .env (gitignored)
node --experimental-strip-types --no-warnings src/index.ts my-triager
```

Add `--live` to allow write actions to actually execute; default is dry-run.

## Operating a coworker

### Leave a note

Anytime, from any terminal:

```
bin/note-to.sh alex-triage "Please prioritise ILO parser bugs today"
bin/note-to.sh alex-triage "New label 'security' created — use it for auth"
bin/note-to.sh alex-triage "Weekend — take it easy, low tempo"
```

Notes appear prominently in the coworker's next tick under `📬 UNREAD NOTES
FROM YOUR MANAGER (read and consider FIRST — these override recent
inferences)`. Marked as read after that tick.

### Read what they've been doing

```
tail -f coworkers/<name>/state/stream.log      # everything, one line per tick
tail -f coworkers/<name>/state/highlights.log  # actions, thoughts, notes
```

Or query the structured event log:

```
sqlite3 coworkers/<name>/state/events.db \
  "SELECT ts, kind, substr(payload,1,150) FROM events ORDER BY id DESC LIMIT 20"
```

Or run the fleet dashboard:

```
node --experimental-strip-types --no-warnings src/dashboard.ts
# http://localhost:7777
```

### Wake them up (event-driven)

The coworker listens on `WAKE_PORT` for external events. Any POST triggers
an immediate tick that bypasses the quiet gate.

```
curl -X POST http://127.0.0.1:7778/wake
```

Point Linear/Slack/GitHub webhooks at that URL (via smee.io for local dev
or a tunnel for production — see `docs/webhooks.md`).

## Extending: skills, MCP tools, plugins

All three drop in without editing runtime code. Pick whichever matches the
capability you're adding.

### Anthropic-style skills (Hermes / OpenClaw / Claude Code compatible)

These are folders holding a `SKILL.md` — instructions/playbooks the *model
reads in context*, not APIs to call. Great for style ("caveman"), procedures
("systematic-debugging"), or domain knowledge ("research-paper-writing").

```
# Drop the skill folder in
cp -r some-skill ~/.hermes/skills/some-skill

# Or clone a repo full of them
git clone https://github.com/... ~/.hermes/skills-extra
```

In `.env`:

```
SKILLS_DIR=/home/you/.hermes/skills            # default; supports Anthropic Agent Skills layout
ACTIVE_SKILLS=caveman,systematic-debugging     # skills whose FULL body is inlined into the prompt
```

Skills not in `ACTIVE_SKILLS` still appear in the prompt as a one-line index
the model can consult. Anthropic Agent Skills, Hermes skills, and OpenClaw
skills all use the same shape, so any one drops into any of these locations.

### MCP tools (Model Context Protocol servers — the biggest ecosystem)

Any MCP server becomes a set of callable tools automatically. The runtime
spawns the server as a subprocess over stdio and registers each of its
tools as `mcp.<name>.<tool>`.

In `.env`:

```
MCP_SERVERS='[
  {"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],
   "env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_..."}},
  {"name":"slack","command":"npx","args":["-y","@modelcontextprotocol/server-slack"],
   "env":{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_TEAM_ID":"T..."}},
  {"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/some/allowed/path"]}
]'
```

Auth is per-server, via each server's own env vars. The coworker sees the
tools in its `TOOLS.md` allowlist by prefix:

```md
- mcp.github          # all github tools
- mcp.slack.post_message   # only this one
```

Dry-run gating (`--live` off) blocks writes for MCP tools too.

### Vercel Eve `agent/` folders

Any Eve-shaped folder loads via `src/adapters/eve.ts` — instructions become
role, `skills/*` become procedural memory, `tools/*.ts` are surfaced by name
(need porting to our `ToolDef` shape for callability).

### Native tools (write your own)

For anything without an MCP server or where you want no subprocess overhead:

```ts
// src/tools/mything.ts
import type { ToolDef } from "../runtime/tools.ts";

export const mySensor: ToolDef = {
  name: "mything.status",
  kind: "sensor",                // or "action"
  description: "What this does — shown to the model",
  inputSchema: { type: "object", properties: {} },
  handler: async (input, ctx) => {
    if (ctx.dryRun && this.kind === "action") return { dryRun: true, would: input };
    // ...
  },
};

export const myTools: ToolDef[] = [mySensor];
```

Then one line in `src/index.ts`:

```ts
import { myTools } from "./tools/mything.ts";
for (const t of myTools) tools.register(t);
```

Grant per-coworker access by mentioning `mything` in that coworker's `TOOLS.md`.

## Layout

```
src/
  runtime/     tick, sensors, deliberate, actions, memory, boundaries,
               hygiene, log, tempo, semantic, injection
  tools/       linear, slack, gdocs, ... (adapters)
  delegates/   coder (future: pi / claude code / claude agent sdk)
examples/      sanitised coworker templates (committed)
  generic-triage/
    role/      ROLE, RESPONSIBILITIES, AUTHORITY, BOUNDARIES, RITUALS,
               RELATIONSHIPS, TOOLS, WORKSPACE
coworkers/     real instances — GITIGNORED
  <name>/
    role/      per-instance role docs (workspace facts, style prefs)
    state/     sqlite: events, memory, promises, resources + memory/MEMORY.md
templates/     systemd unit template
bin/           new-coworker generator
```

MIT.
