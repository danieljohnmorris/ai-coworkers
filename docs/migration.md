# Migrating an existing agent into ai-coworkers

You have a working agent in another framework — Hermes, OpenClaw, or Vercel
Eve. You want to run it as an ai-coworker without re-authoring from scratch.
This page maps every source-format artifact to its ai-coworkers destination,
and documents exactly what does not port cleanly.

Three scripts do the copy:

```bash
bin/import-hermes.sh   <hermes-agent-dir>       <coworker-name>
bin/import-openclaw.sh <openclaw-workspace-dir> <coworker-name>
bin/import-eve.sh      <eve-agent-dir>          <coworker-name>
```

Each prints a checklist at the end — ✓ for what ported directly, ⚠ for what
needs human authoring or manual mapping.

## Mapping matrix

| Source concept | ai-coworkers destination | Ported by | Notes |
|---|---|---|---|
| **Hermes** `SOUL.md` | `role/ROLE.md` | script | Direct copy — same "persona + how you work" role |
| **Hermes** `USER.md` | `role/RELATIONSHIPS.md` | script | Direct copy |
| **Hermes** `MEMORY.md` | `state/memory/MEMORY.md` | script | Subject to our 2KB semantic cap; first `dreamOnce` will compact |
| **Hermes** `skills/` | Loaded in-place | adapter | Set `SKILLS_DIR` or symlink into `~/.hermes/skills/` |
| **OpenClaw** `SOUL.md` | `role/ROLE.md` | script | Direct copy |
| **OpenClaw** `AGENTS.md` | `role/RESPONSIBILITIES.md` | script | Direct copy |
| **OpenClaw** `TOOLS.md` | `role/TOOLS.md` | script | May need trimming to tools we actually register |
| **OpenClaw** `MEMORY.md` | `state/memory/MEMORY.md` | script | Same 2KB cap |
| **OpenClaw** `skills/` | Loaded via Hermes adapter | adapter | Same SKILL.md convention |
| **Eve** `instructions.md` | `role/ROLE.md` | script | Direct copy |
| **Eve** `tools/` | Loaded in-place | adapter | Set `EVE_AGENT_DIR` |
| **Eve** `schedules/` | `role/RITUALS.md` | script | Files concatenated as numbered sections; fold into a single tempo policy |
| **Eve** `skills/` | Loaded via Hermes adapter | adapter | Same convention |
| **Eve** `channels/` | Use our `ask` tool recipients | **manual** | See below |
| **Eve** `agent.ts` (model config) | Env vars | **manual** | `OLLAMA_HOST`, `OLLAMA_API_KEY`, `COWORKER_MODEL` |

## What ai-coworkers has that source frameworks don't

Every import writes stub files for these — you'll want to fill them in
before running `--live`:

- `role/AUTHORITY.md` — what the coworker may decide alone vs. must escalate
- `role/BOUNDARIES.md` — hard "must not touch" list + resource caps (LLM
  calls/day, worktrees, subprocess idle). See the reference in
  `examples/generic-triage/role/BOUNDARIES.md`.
- `role/RITUALS.md` — recurring behaviour + tempo targets (used by the
  quiet gate + adaptive interval)
- `role/RESPONSIBILITIES.md` — for Hermes/Eve where it's implicit in the
  persona; for OpenClaw it comes from AGENTS.md
- `role/RELATIONSHIPS.md`, `role/WORKSPACE.md` — usually short markdown
  describing team + world context

## Channel mapping (Eve → `ask`)

Eve `channels/` are integrations (Slack bot, Discord bot, HTTP webhook).
ai-coworkers doesn't run channels as long-lived processes — a coworker
initiates outbound messages via the `ask` tool:

| Eve channel | ai-coworkers `to=` |
|---|---|
| `channels/slack.ts` (`postToChannel`) | `slack:#channel-name` |
| `channels/slack.ts` (`dmUser`) | `slack:@USERID` |
| `channels/discord.ts` | not yet — add a discord adapter |
| `channels/http.ts` webhook receiver | run `WAKE_PORT=<n>` (see `docs/webhooks.md`) |

## Inbound messages

Eve channels also *receive* messages. In ai-coworkers, external systems
push into a coworker via:

- `bin/note-to.sh <coworker> "message"` — write to `state/inbox.md`
- HTTP `POST /wake` with a payload → `forceDeliberate` tick + inbox entry
  (see `docs/webhooks.md`)

## After importing

1. Fill in the stub role docs (BOUNDARIES.md is the most important — the
   coworker won't do anything write-shaped until at least the resource
   limits are set).
2. Run in dry-run first: `node --experimental-strip-types --no-warnings
   src/index.ts <coworker-name>` — omit `--live`.
3. Tail `coworkers/<name>/state/highlights.log` to watch it think.
4. Once you're happy, add `--live` to enable write actions.

## Reporting a mapping bug

If a source format field lands somewhere unexpected — or should map to
something we haven't documented — open an AIC ticket with the source file
attached and what you expected to happen.
