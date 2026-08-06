# ADR 0007 — config file vs env vars

**Status:** Accepted (2026-08-06).

## Context

Until now, every knob a coworker exposes has lived in an environment
variable — `WAKE_MODE`, `EXTRACT_ENTITIES`, `MAX_TOOLS_PER_TICK`,
`PII_MASK`, `NOTE_REQUIRE_SIGNED`, and a couple of dozen others.
Environment variables were convenient when the audience was a small
group of engineers who were happy to read `AGENTS.md` end-to-end and
paste values into a shell profile.

That audience is changing. This harness is being handed to
**non-technical people and the AI coding agents they work with**.
Both groups struggle with env vars:

- **Env is invisible.** There is no schema, no discoverability, no
  autocomplete. Typing `WAKE_MOD=webhook` silently keeps the default;
  the coworker doesn't complain until you notice it isn't behaving.
- **Env has no defaults you can read.** A non-technical operator can't
  look at the current setup and say "here's what I set, here's what
  I'm getting by default." The only way to know is to read the source.
- **Env is hostile to AI-agent setup.** An agent asked to configure a
  coworker cannot introspect what knobs exist, what values are legal,
  or what the current value is. It has to grep `src/` and guess.
- **Env conflates secrets with behaviour.** `OLLAMA_API_KEY` and
  `MAX_TOOLS_PER_TICK` are treated identically today, even though one
  must never land on disk and the other is exactly the kind of thing a
  human wants to open a text editor and change.

Meanwhile, this repo already uses JSON files for structured per-coworker
config: `role/SENSORS.json`, `role/WEBHOOKS.json`, `role/rituals/*.json`.
The pattern of "schema-validated JSON in the coworker directory" is
already the harness convention for anything more shaped than a single
string.

## Decision

Split coworker configuration into two layers by concern, not by
convenience.

**`.env` (unchanged surface)** stays for:

- **Secrets** — `OLLAMA_API_KEY`, `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`,
  `NOTE_HMAC_SECRET`, `LINEAR_WEBHOOK_SECRET`, and any future bearer
  token or signing key. Secrets must never land in a file that gets
  committed by accident or dumped into logs by a debug print, and the
  existing `.env` handling (gitignored, per-coworker overlay, redacted
  from streams by `secret_redaction.ts`) is already correct for them.
- **Host binding and deployment glue** — `WAKE_PORT`, `DASHBOARD_PORT`,
  `OLLAMA_HOST`, `LOG_FORMAT`. These are what a systemd unit or Docker
  entrypoint injects. Keeping them in env lets the same coworker
  directory move between hosts without editing tracked config.
- **Development escape hatches** — `COWORKER_SKIP_BASELINE`,
  `AICW_SANDBOX`. Ephemeral flags an engineer sets in a shell for one
  run, not something that belongs in a checked-in JSON file.

**`config.json` (new)** at `coworkers/<name>/config.json` for
**behavioural knobs** — anything a human or an agent would reasonably
open the coworker's config to change. This first cut migrates five
keys to prove the pattern:

- `wake_mode` (was `WAKE_MODE`)
- `extract_entities` (was `EXTRACT_ENTITIES`)
- `max_tools_per_tick` (was `MAX_TOOLS_PER_TICK`)
- `pii_mask` (was `PII_MASK`)
- `note_require_signed` (was `NOTE_REQUIRE_SIGNED`)

The schema lives at `src/runtime/config-schema.json` (JSON Schema
draft 2020-12), validated at load time by the same Ajv2020 already
used for MCP tool schemas. Unknown keys are rejected. Missing keys
resolve to the schema's `default`.

**Env fallback is preserved** for every migrated key so operators
running today don't break tomorrow. If a knob is set in `config.json`,
`config.json` wins and a warning is logged noting the env is being
overridden. If a knob is only in env, the env value is used and a
one-time deprecation warning is logged: `env fallback for <KEY> — set
in config.json instead (see AGENTS.md).`

## Consequences

- **Agents can introspect the schema.** An AI coding agent asked to
  configure a coworker can read `src/runtime/config-schema.json`,
  discover every legal knob, its type, its default, and its
  description in one file — no source grep.
- **Non-technical humans get a wizard.** `bin/configure.sh <coworker>`
  walks each knob using the schema's descriptions and enum values.
- **Typos are rejected loudly.** `wake_mode: "webhok"` fails at
  startup with a clear message naming the offending key, instead of
  silently defaulting.
- **Defaults are self-documenting.** The schema is the single source
  of truth for what a knob does and what value it takes when unset.
- **Secrets stay out of tracked files by construction.** The `.env`
  boundary makes it structurally impossible to check a token into git
  by "helpfully" adding it to `config.json`.
- **Migration is opt-in.** Existing coworkers with a populated `.env`
  keep working; the deprecation warning nudges without breaking.

## What stays env forever

- **Secrets.** `config.json` is not encrypted, is easy to `cat`, and
  would need special ignore rules. The env boundary is stronger.
- **Host binding** (`WAKE_PORT`, `DASHBOARD_PORT`, `OLLAMA_HOST`).
  These fit systemd `Environment=` and Docker `-e` cleanly and change
  when a coworker moves between hosts — behaviour that follows the
  coworker directory does not.
- **`COWORKER_SKIP_BASELINE`, `AICW_SANDBOX`.** Development escape
  hatches, not steady-state config.

Later PRs may migrate more behavioural keys. The full env-var table in
`AGENTS.md` continues to enumerate everything the runtime reads.

## Reference precedent

The pattern chosen here — schema-validated JSON in the coworker's
directory — matches what the harness already does for structured
config:

- `coworkers/<name>/role/SENSORS.json` — declarative MCP sensors.
- `coworkers/<name>/role/WEBHOOKS.json` — declarative inbound webhooks.
- `coworkers/<name>/role/rituals/*.json` — structured recurring jobs.

`config.json` is the same shape one level up: coworker-scoped rather
than role-scoped, because behavioural knobs are properties of the
running process, not of the role definition.
