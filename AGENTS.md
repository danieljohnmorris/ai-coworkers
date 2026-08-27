# AGENTS.md — Setup guide for AI agents

Audience: an AI coding agent (Claude Code, Cursor, GPT, etc.) reading this
repo cold and being asked to bring up a coworker. Every command is
copy-pasteable, every env var is enumerated, every file path is relative to
the repo root.

For the human-facing pitch and design lineage, see [README.md](README.md).
Non-technical operators building coworkers should read
[docs/coworker-builder-guide.md](docs/coworker-builder-guide.md) first.

---

## What this repo is

`ai-coworkers` runs long-running AI processes with **roles**, **hard
boundaries**, and a **tick loop**. A coworker is a directory of markdown
(role docs + state), not a chat session. Each tick reads the world through
read-only sensors, passes a quiet gate (skip the LLM if nothing changed),
deliberates, checks the proposed action against `BOUNDARIES.md`, then acts.
Default is **dry-run** — every write returns `{dryRun: true, would: {...}}`
until you pass `--live`.

---

## Repo layout

```
src/            runtime (tick loop, memory, hygiene, boundaries, wake server)
  runtime/     core loop + storage + policy
  tools/       native tools (linear, github, slack, gmail, memory, ask, …)
  adapters/    ecosystem bridges (mcp, hermes, eve, acp)
coworkers/     one directory per live coworker (mostly gitignored)
examples/      committed coworker templates you copy from
docs/          operator docs (webhooks, systemd, ADRs, comparison, …)
bin/           setup + verify + admin shell scripts
templates/     internal scaffolds used by bin/new-coworker*.sh
test/          vitest suite + fake LLM/API fixtures
```

Entry point: `src/index.ts`. Everything else hangs off it.

---

## Prerequisites

- Node **>= 22** (uses `node:sqlite` and `--experimental-strip-types`).
- `npm install` at repo root.
- An OpenAI-compatible LLM endpoint. Default is `https://ollama.com`
  (Ollama Cloud) — override with `OLLAMA_HOST` for a self-hosted or
  OpenAI-proxy endpoint.
- Optional per-integration CLIs: `hermes` (for Slack + Gmail setup),
  `smee-client` (for local webhook tunnelling).

---

## Environment variables

Two scopes:

- **Shell / root `.env`** — applies to every coworker.
- **`coworkers/<name>/.env`** — per-coworker overrides, overlaid on top.
  Gitignored. `src/runtime/credentials.ts` loads it.

Every variable actually read by `src/`:

| Name | Required? | Default | Purpose |
|---|---|---|---|
| `OLLAMA_API_KEY` | yes | — | Bearer token for the LLM endpoint. |
| `OLLAMA_HOST` | no | `https://ollama.com` | LLM base URL (OpenAI-compatible). |
| `COWORKER_MODEL` | no | `gemma4:cloud` | Main deliberation model. |
| `TRIAGE_MODEL` | no | unset | If set, a cheap-first preflight model asked "act or skip?" before the expensive prompt each tick. |
| `EXTRACT_ENTITIES` | no | unset | **Deprecated in env — use `extract_entities` in `config.json`.** Set to `1` to enable the per-tick entity evaluator (extracts people, projects, workspace facts into the existing entity + notes files). Uses `TRIAGE_MODEL` if set, else `COWORKER_MODEL`. Default off. See [Entity evaluator](#entity-evaluator). |
| `TICK_INTERVAL_MS` | no | `300000` | Base tick interval (5 min). |
| `MIN_TICK_INTERVAL_MS` | no | `15000` | Floor when the model asks to `pace: faster`. |
| `MAX_TICK_INTERVAL_MS` | no | `1800000` | Cap for adaptive backoff (30 min). Ignored when the role sets `Cadence: constant`. |
| `MAX_TOOLS_PER_TICK` | no | runtime default | **Deprecated in env — use `max_tools_per_tick` in `config.json`.** Max tool calls chained per tick. |
| `COWORKER_SKIP_BASELINE` | no | unset | Set to `1` to disable the framework-owned baseline prompt (see [Baseline prompt](#baseline-prompt)). Otherwise the baseline is prepended to every coworker's system prompt. |
| `WAKE_MODE` | no | `both` | **Deprecated in env — use `wake_mode` in `config.json`.** Activity source. `tick` = periodic tick loop only; `webhook` = wake HTTP server only (no scheduled ticks); `both` = both. See [Activity modes](#activity-modes). Unknown values fall back to `both` with a warning. |
| `WAKE_PORT` | no | unset | Port for HTTP wake endpoint. Required if you want webhooks or `WAKE_MODE=webhook`. |
| `WAKE_SECRET` | no | unset | Shared secret for `/wake`; presence flips bind to `0.0.0.0`. |
| `METRICS_ENABLED` | no | unset | Set to `1` to expose Prometheus `/metrics` on `WAKE_PORT`. |
| `MCP_SERVERS` | no | unset | JSON array of MCP servers to spawn (see MCP section). |
| `ACTIVE_SKILLS` | no | unset | Comma-separated skill names to inline in the system prompt (Hermes adapter). |
| `SKILLS_DIR` | no | `~/.hermes/skills` | Where the Hermes adapter looks for skills. |
| `ACP_AGENT_CMD` | no | unset | If set, gives the coworker a `code.delegate` tool that spawns this ACP agent. |
| `ACP_ALLOW_KINDS` | no | runtime default | Which tool kinds the ACP agent may call. |
| `ACP_TIMEOUT_MS` | no | runtime default | Timeout for ACP agent delegations. |
| `LINEAR_WEBHOOK_SECRET` | no | unset | HMAC secret referenced by `WEBHOOKS.json` `auth.secretEnv`. Webhook auth is separate from tool auth (which is now OAuth via the Linear MCP server). |
| `GITHUB_TOKEN` | no | — | For the GitHub tools. |
| `WATCHED_REPOS` | no | unset | Comma-separated `owner/repo` list for the GitHub sensor. |
| `SLACK_BOT_TOKEN` | no | — | For the Slack tools (`xoxb-…`). |
| `SLACK_WATCHED_CHANNELS` | no | unset | Comma-separated channel names/IDs. |
| `MANAGER_SLACK` | no | unset | Manager Slack handle for escalations. |
| `PII_MASK` | no | unset | **Deprecated in env — use `pii_mask` in `config.json`.** Set to `1` to enable reversible identifier masking in prompts. |
| `NOTE_HMAC_SECRET` | no | unset | Signs operator notes so `bin/note-to.sh` output is trusted. |
| `NOTE_REQUIRE_SIGNED` | no | unset | **Deprecated in env — use `note_require_signed` in `config.json`.** If set, reject unsigned notes. |
| `LOG_FORMAT` | no | unset | Set to `json` for JSONL logs. |
| `AICW_SANDBOX` | no | unset | Sandbox mode for tool execution. |
| `DASHBOARD_PORT` | no | `7777` | `src/dashboard.ts` fleet view port. |

If a variable you expected isn't here, do **not** invent it — grep
`src/` first (`grep -rE 'env\.[A-Z_]+' src/`).

## Configuration

Behavioural knobs are moving from environment variables to a
schema-validated JSON file at `coworkers/<name>/config.json`. Env stays
for secrets, host binding, and development escape hatches; JSON is for
anything a human or an agent would open the config to change. See
[ADR 0007](docs/adr/0007-config-file-vs-env-vars.md) for the full
rationale.

Schema: [`src/runtime/config-schema.json`](src/runtime/config-schema.json)
(JSON Schema draft 2020-12). Agents configuring a coworker should read
this file rather than guessing: it enumerates every legal knob, its
type, its default, and its description.

Currently migrated (env still works as a deprecated fallback):

| config.json key | Legacy env | Type | Default |
|---|---|---|---|
| `wake_mode` | `WAKE_MODE` | enum: `tick` \| `webhook` \| `both` | `both` |
| `extract_entities` | `EXTRACT_ENTITIES` | boolean | `false` |
| `max_tools_per_tick` | `MAX_TOOLS_PER_TICK` | integer 1–100 | `8` |
| `pii_mask` | `PII_MASK` | boolean | `false` |
| `note_require_signed` | `NOTE_REQUIRE_SIGNED` | boolean | `false` |
| `work_hours` | — | object (optional) | absent (24/7) |

### Work hours

Optional. If `work_hours` is absent from `config.json`, the coworker
runs 24/7 exactly as before — no change. If it is present, the periodic
tick cadence is adjusted outside the configured window per
`out_of_hours`. **Webhooks, rituals and due promises always fire
regardless of the window** — work_hours only touches the tick loop.

```json
{
  "work_hours": {
    "timezone": "Europe/London",
    "days": [1, 2, 3, 4, 5],
    "start": "09:00",
    "end": "18:00",
    "out_of_hours": "webhook_only",
    "out_of_hours_interval_min": 60
  }
}
```

Fields:

- `timezone` — IANA name (`Europe/London`, `Asia/Tokyo`, …). Defaults to
  the system timezone if omitted.
- `days` — ISO weekday numbers on which the window applies (1=Mon, 7=Sun).
  Empty or omitted = every day.
- `start`, `end` — `HH:MM` 24-hour local. Both required if either set.
  If `end < start` the window spans midnight (e.g. `22:00`-`06:00`).
- `out_of_hours` — one of:
  - `"normal"` (default) — no cadence change; the block is informational.
  - `"webhook_only"` — periodic tick disabled outside hours (base + max
    interval pinned to 24h). Same effect as `wake_mode=webhook`, but
    time-scoped: in-hours behaviour follows `wake_mode`.
  - `"reduced"` — minimum tick interval clamped to
    `out_of_hours_interval_min` minutes outside hours; in-hours cadence
    is unchanged.
- `out_of_hours_interval_min` — integer minutes, default `60`. Only
  meaningful when `out_of_hours` is `"reduced"`.

Composes with [`wake_mode`](#activity-modes): a coworker can have
`wake_mode=both` for full in-hours coverage and effectively become
webhook-only overnight via `work_hours.out_of_hours=webhook_only`. The
runtime emits a `work_hours.transition` event on each boundary crossing
so the shift is auditable in `stream.log` and the event log.

**Caveat — dead-time combination:** if `wake_mode=tick` (no wake HTTP
server) AND `out_of_hours=webhook_only` (periodic tick disabled
out-of-hours), the coworker has no wake source out-of-hours at all.
Rituals and due promises will queue until the next in-hours tick — they
will not fire on their scheduled time. The runtime logs a startup
warning when it sees this combination. Use `wake_mode=both` if you want
event-driven wakes to still work out-of-hours.

**Transition latency:** the `work_hours.transition` event fires on the
first tick *after* a boundary is crossed, not at the boundary itself.
Under `out_of_hours=webhook_only` this can mean hours of latency — the
transition back into working hours won't be emitted until a webhook (or
the pinned 24h tick) wakes the coworker. Combine with `wake_mode=both`
if you need tight transition timing.

Non-technical operators can walk the schema interactively:

```
bin/aicw configure <coworker>   # legacy: bin/configure.sh (deprecated symlink)
```

Loader: `src/runtime/coworker_config.ts` — `config.json` wins when both
sources set a key (warning logged); env-only wins log a one-time
deprecation warning; unset in both falls to the schema default; schema
violations throw at startup naming the offending key.

---

## Creating a coworker

Three options, in increasing effort:

```bash
cp -r examples/generic-triage coworkers/my-triage        # start from a template
bin/aicw new my-triage                                   # blank skeleton
bin/aicw new my-triage --wizard                          # guided: template + integrations + config
bin/aicw new-interview my-triage                         # JD-style Q&A → writes role docs
# Legacy `bin/new-coworker.sh` / `bin/new-coworker-interview.sh` remain as deprecated symlinks.
```

Templates available under `examples/`:

- `generic-triage` — Linear triage engineer.
- `pr-reviewer` — reviews open PRs on watched GitHub repos.
- `project-manager` — project health summaries, aging tickets.
- `scribe` — keeps README + docs honest as code changes.
- `trace` — incident RCA: stack traces + git history.
- `log` — auto-changelog + GitHub releases on tags.
- `watchtower` — monitoring with aggressive dedup.

---

## Role docs

Each coworker owns a directory `coworkers/<name>/role/` containing markdown
the runtime parses on every tick (with hot-reload — `src/index.ts` watches
`role/` recursively and re-parses on any `.md` or `.json` change).

Reference set: `examples/generic-triage/role/`.

| File | Encodes |
|---|---|
| `ROLE.md` | Identity, working style, tone. Rendered into the system prompt. |
| `RESPONSIBILITIES.md` | What this coworker owns. |
| `AUTHORITY.md` | What they may decide alone vs escalate. |
| `BOUNDARIES.md` | Hard "must not touch" list + resource caps (max LLM/day, max worktrees). Enforced pre-execute. |
| `RITUALS.md` | Recurring behaviors + tempo target. Also declares `Cadence: adaptive|constant`. |
| `WORKSPACE.md` | Stable facts about the world (team names, project glossary). |
| `TOOLS.md` | Which tools they may use (subset of the registered set). |
| `RELATIONSHIPS.md` | Named peers, managers, escalation targets. |
| `WEBHOOKS.json` | Declarative inbound webhooks (see below). |
| `rituals/*.json` | Structured recurring jobs; re-read every tick. |

### Baseline prompt

Every coworker's system prompt is prepended with a framework-owned
**baseline** — a short "how you work" preamble covering universal
coworker hygiene: tool categories (sensor / action / memory), escalation
via `ask to="manager"`, memory hygiene (`memory.note` durable
discoveries; `memory.notes_read` at the start of a tick), tool-failure
discipline (retry once, then escalate — never loop), boundary respect
(BOUNDARIES.md is non-negotiable; escalate for boundary changes), and
dry-run-vs-live semantics.

The authoritative content lives at
[`src/runtime/prompts/coworker_baseline.md`](src/runtime/prompts/coworker_baseline.md).
Read that file to see exactly what your coworkers get for free before
their own role docs are read.

Each baseline rule sits under a kebab-case `## <name>` heading
(`## escalation`, `## memory-hygiene`, etc.). A role doc can **override**
any section by including a `## <same-name>` heading — the baseline's
version is stripped before concatenation, and the role's version wins.
Add a role heading only when the default is wrong for that coworker;
otherwise leave the baseline to speak for itself.

Escape hatch: set `COWORKER_SKIP_BASELINE=1` to omit the baseline
entirely (useful for tests or minimal harnesses).

---

## Connecting a service

Each setup script writes tokens to `coworkers/<name>/.env` (gitignored).

### Linear

Linear is wired through its remote MCP server
(`https://mcp.linear.app/mcp`) — no native `src/tools/linear.ts`, no
setup script, no `LINEAR_API_KEY`. Setup is three edits:

1. Add the server to the coworker's env
   (`coworkers/<name>/.env`):

   ```
   MCP_SERVERS='[{"name":"linear","url":"https://mcp.linear.app/mcp","oauth":{"scopes":["read","write"]}}]'
   ```

2. Declare the sensors you want in
   `coworkers/<name>/role/SENSORS.json` (see
   `examples/generic-triage/role/SENSORS.json` for the reference
   `linear.new_issues` / `linear.untagged_issues` /
   `linear.workspace_snapshot` entries). Sensor **names** are kept
   stable so `WEBHOOKS.json` `onEvent.invalidate` targets still match;
   the underlying **tool** field points at the MCP tool.

3. Start the coworker. First tick prints an OAuth authorization URL to
   stdout; open it in a browser (ideally as a dedicated Linear user —
   see [docs/dedicated-linear-user.md](docs/dedicated-linear-user.md)),
   consent, and the runtime captures the redirect and caches tokens at
   `coworkers/<name>/state/mcp-tokens/linear.json`. Subsequent
   restarts reuse the cached tokens.

Webhook config (`LINEAR_WEBHOOK_SECRET`, `WEBHOOKS.json`) is
unchanged — webhook signature auth is independent of tool auth.

### Slack

```bash
bin/aicw slack <coworker>          # legacy: bin/setup-slack.sh
bin/aicw verify-slack <coworker>   # legacy: bin/verify-slack.sh
```

Requires the `hermes` CLI. Generates a Slack app manifest via `hermes slack
manifest`, walks you through creating and installing the app at
https://api.slack.com/apps, then prompts for the `xoxb-…` bot token and
signing secret. Verify calls Slack `auth.test`.

### Gmail (Google Workspace)

```bash
bin/aicw gmail <coworker>          # legacy: bin/setup-gmail.sh
bin/aicw verify-gmail <coworker>   # legacy: bin/verify-gmail.sh
```

Wraps the Hermes `google-workspace` skill's `setup.py`. One-time
prerequisite: a Google Cloud project with Gmail/Drive/Docs/Calendar/Sheets
APIs enabled and a "Desktop app" OAuth credential downloaded as
`credentials.json`. The resulting token lands at
`coworkers/<name>/state/hermes-home/google_token.json` — scoped per
coworker via `HERMES_HOME`. Verify runs one `in:inbox` search through
Hermes's `google_api.py`.

---

## Webhooks

Coworkers can declare inbound webhooks in
`coworkers/<name>/role/WEBHOOKS.json`. The runtime
(`src/runtime/webhooks_loader.ts` + `webhook_router.ts`) loads them on
startup, verifies signatures with a closed set of named verifiers,
optionally filters the payload, and fires an immediate wake.

Top-level is an array. Full field schema:

```json
[
  {
    "name": "linear",
    "path": "/webhook/linear",
    "auth": {
      "type": "hmac-sha256",
      "header": "linear-signature",
      "secretEnv": "LINEAR_WEBHOOK_SECRET",
      "maxAgeSeconds": 300
    },
    "filter": {
      "jsonPath": "data.team.key",
      "allow": ["ILO", "AIC"]
    },
    "onEvent": {
      "wake": true,
      "invalidate": ["linear.new_issues", "linear.workspace_snapshot"]
    }
  }
]
```

**`auth.type`** — closed set:

| type | header default | notes |
|---|---|---|
| `hmac-sha256` | you must name it | HMAC-SHA256(body), hex-compare. |
| `github-sha256` | `x-hub-signature-256` | Strips `sha256=` prefix. |
| `slack-v0` | `x-slack-signature` | Slack v0 scheme. Enforces `|now-ts| <= maxAgeSeconds` (default 300). |
| `none` | — | Always accepts. Startup warning is logged. |

Adding a new scheme is a PR to `src/runtime/webhook_verifiers.ts`, not a
JSON edit — this closed set is deliberate.

**`filter.jsonPath`** — dotted path into the parsed JSON body
(`data.team.key`, `pull_request.user.login`, etc.). Simple walk, no JSONPath
operators. `allow` is a string array; the value at the path must be
`===`-equal to one of them.

**`onEvent.invalidate`** — sensor cache keys to force-refresh on the
resulting tick, so the coworker sees the change immediately instead of
serving a cached snapshot.

**Return codes** (from `POST /webhook/<name>`):

| Code | Meaning |
|---|---|
| 200 | Signature valid, filter matched (or absent), coworker woken. |
| 202 | Signature valid, filter did not match; ack, no wake. |
| 401 | Missing or bad signature. |
| 404 | No webhook spec matches that path. |
| 503 | Spec's `secretEnv` is not set in the process env. |

Example — GitHub:

```json
{
  "name": "github",
  "path": "/webhook/github",
  "auth": { "type": "github-sha256", "secretEnv": "GITHUB_WEBHOOK_SECRET" },
  "onEvent": { "wake": true, "invalidate": ["github.open_prs"] }
}
```

Example — Slack:

```json
{
  "name": "slack",
  "path": "/webhook/slack",
  "auth": { "type": "slack-v0", "secretEnv": "SLACK_SIGNING_SECRET", "maxAgeSeconds": 300 },
  "onEvent": { "wake": true }
}
```

Full tunnelling guide (smee for local dev, Cloudflare / Tailscale for
prod): [docs/webhooks.md](docs/webhooks.md).

---

## MCP servers

Any MCP-compatible server registers its tools as `mcp.<name>.<tool>`. One
env var per fleet (or per coworker, since `.env` is per-coworker). Two
transports are supported: **stdio** (spawn a subprocess) and **http**
(Streamable HTTP endpoint). Exactly one of `command` or `url` must be set
per entry.

Stdio (local subprocess):

```
MCP_SERVERS='[
  {"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]},
  {"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp/agent-scratch"]}
]'
```

HTTP, unauthenticated:

```
MCP_SERVERS='[
  {"name":"public","url":"https://mcp.example.com/mcp"}
]'
```

HTTP with a bearer token sourced from an env var (recommended for
authenticated remote MCPs that use static tokens):

```
MCP_SERVERS='[
  {"name":"remote","url":"https://mcp.example.com/mcp","bearerEnv":"EXAMPLE_TOKEN"}
]'
```

HTTP with arbitrary static headers:

```
MCP_SERVERS='[
  {"name":"remote","url":"https://mcp.example.com/mcp","headers":{"X-Api-Key":"…","X-Trace":"…"}}
]'
```

Full per-server config: `{ name, command?, args?, env?, url?, headers?, bearerEnv?, oauth? }`.
`command` XOR `url`; setting both, neither, or a missing `bearerEnv`
throws a clear error at connect time. `oauth` requires `url` and is
mutually exclusive with `bearerEnv`.

### OAuth-based MCP servers

Remote MCP servers that require OAuth 2.1 (e.g. Linear's
`https://mcp.linear.app/mcp`) are supported via the `oauth` block:

```
MCP_SERVERS='[
  {"name":"linear","url":"https://mcp.linear.app/mcp","oauth":{"scopes":["read","write"]}}
]'
```

Optional fields: `oauth.redirectPort` (loopback listener port; default
picks a free port), `oauth.callbackHost` (default `127.0.0.1`).

Flow on first connect:

1. The runtime opens a Streamable HTTP transport with an OAuth client
   provider. The server returns 401 with a `WWW-Authenticate` header
   pointing at the authorization-server metadata endpoint.
2. The SDK fetches metadata (RFC 8414 / RFC 9728), does Dynamic Client
   Registration (RFC 7591) to obtain a `client_id`, generates a PKCE
   verifier (RFC 7636), and prints the authorization URL to stdout.
3. Open the URL in a browser, consent, and the AS redirects to
   `http://127.0.0.1:<port>/callback?code=…`. The runtime's loopback
   listener captures the code and exchanges it for access + refresh
   tokens.
4. Tokens (and the DCR client info + PKCE state) land on disk at
   `coworkers/<name>/state/mcp-tokens/<server>.json` (mode `0600`).
   Subsequent restarts reuse the cached client + refresh flow — no
   browser prompt.

If the refresh token is rejected (server revoked it, tenant deleted,
scope changed), the SDK will re-invoke the browser flow. To force a
fresh authorization, delete
`coworkers/<name>/state/mcp-tokens/<server>.json` and restart.

**Headless caveat**: OAuth-based MCPs are best for interactive setup and
OK-but-fragile for long-running headless systemd processes. A refresh
failure at 3am means silent breakage until an operator opens the printed
URL from a machine with a browser. If the server also supports a
long-lived personal API key (bearer token / API token — Linear does),
prefer `bearerEnv` for headless deployments and reserve `oauth` for
interactive workstations.

MCP tools are all registered as `kind: "action"` — MCP doesn't distinguish
read vs write, so gate anything sensitive via `BOUNDARIES.md` /
`AUTHORITY.md` instead of relying on the tool taxonomy.

---

## Sensors and the quiet gate

**Sensors** are read-only tools declared with `kind: "sensor"`. They live
in `src/tools/*.ts` (`github.open_prs`,
`slack.mentions`, `gmail.inbox_check`, `branch_room.status`, etc.) and are
the coworker's window on the world. Sensors are cached with a hygiene TTL
and never mutate anything.

**Quiet gate** — before every tick the runtime asks: did any sensor
observe a change? Any operator note? Any ritual or promise due? If no, the
tick is skipped without spending a single LLM token. This is why an idle
coworker costs nothing to run. Webhooks bypass the gate (`forceNext =
true` in `src/index.ts`) — an external event guarantees the model sees
this tick.

### Declarative MCP sensors

Sensors can also be declared in JSON at
`coworkers/<name>/role/SENSORS.json`. Each spec turns an MCP tool call
into a cached, diff-aware read that feeds `Perception.sensors[]` alongside
native sensors — no TypeScript needed. Top-level is an array:

```json
[
  {
    "name": "github.review_requests",
    "mcp": "github",
    "tool": "list_pulls",
    "args": { "state": "open", "review_requested": "@me" },
    "cacheMs": 60000,
    "summarise": "count"
  }
]
```

Fields:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique per coworker. Also the key webhook specs target via `onEvent.invalidate`. |
| `mcp` | yes | Matches an `MCP_SERVERS` entry name. |
| `tool` | yes | MCP tool name on that server. |
| `args` | no | Object passed to the tool. |
| `cacheMs` | no | Non-negative integer. Default `0` (call every tick). |
| `summarise` | no | Shape reducer — see below. |

`summarise` variants — keeps the perception blob small:

- `"identity"` (default) — full result.
  ```json
  { "summarise": "identity" }   // result: { "issues": [...], "meta": {...} }
  ```
- `"count"` — first array in the result, returned as `{ count: n }`.
  ```json
  { "summarise": "count" }      // result: { "count": 3 }
  ```
- `"first"` — first element of the first array in the result.
  ```json
  { "summarise": "first" }      // result: { "id": 42, "title": "..." }
  ```
- `"a.b.c"` — dotted path; returns the subtree at that path.
  ```json
  { "summarise": "data.issues" } // result: [ ... ]
  ```

Webhook coupling: a `WEBHOOKS.json` entry can list a declarative sensor
in `onEvent.invalidate`. When the webhook fires, the runtime drops the
cached value AND marks the next tick's diff as `changed` for that sensor
— so a webhook that says "this changed" always beats a JSON-equal poll
result. This is the same integration point native sensors already use via
`invalidatePrefix` in `sensor-cache.ts`.

Missing `SENSORS.json` = no declarative sensors, no errors. Validation
errors are logged on startup and the offending spec is skipped.

---

## Memory tools

Coworkers have a small set of action tools for reading and writing their
own long-term memory. All are registered by default; expose them per
coworker by listing `memory` (prefix match) in the role's `TOOLS.md`.

| Tool | Input | Behaviour |
|---|---|---|
| `memory.search` | `{ query: string, limit?: 1..25 }` | FTS5 search over the coworker's own event log. Read-only. |
| `memory.recall` | `{ query: string, purpose?: string }` | `memory.search` + one-paragraph LLM summary. |
| `memory.note_project` | `{ projectKey: string, body: string }` | Save/replace a per-project markdown note. Auto-loaded into perception when the key next appears. Injection-scanned + size-capped. |
| `memory.note_person` | `{ handle: string, body: string }` | Save/replace a per-person note. Auto-loaded when the handle appears. |
| `memory.note` | `{ body: string, tag?: string }` | Append a timestamped freeform entry to `state/notes.md`. 4 KB cap (oldest entries trimmed on the `\n## ` boundary); exact-body repeats are deduplicated. Use for durable observations that don't fit an entity note (e.g. "AGNT team is retired — don't attempt writes"). |
| `memory.notes_read` | `{ grep?: string }` | Read `state/notes.md`. Optional case-insensitive substring filter on entry bodies. |

Writes honour `dryRun` — a dry-run call returns `{dryRun: true, ...}`
without touching disk.

### Reflection

The **reflect** ritual (`src/runtime/reflect.ts`, `dreamOnce`) reads the
past week's `action` / `deliberate` / `boundary.block` / `sensor.error`
events, asks the model to distil them into a compact learnings
paragraph, and promotes that paragraph into semantic `MEMORY.md` (with
a promotion gate, a 25 %-loss guard, a version snapshot, and a
`DREAMS.md` diary of what was added or dropped). A longer weekly
rollup is written to `memory.db`, and raw events older than
`REFLECT_RETENTION_DAYS` (default 30) are pruned.
Events older than the retention window move to the events_archive table instead of being deleted; the hot FTS index covers the hot window only, and archived rows are reachable by id for the upcoming memory-ladder navigation (AIC-128).
Rollups carry level, parent and an event-id source range, and decisions record the event ids they were distilled from; provenance that cannot be validated is written as NULL, never faked.

Reflection ships as a built-in ritual (`reflect.weekly`, Sundays 03:00
UTC) and applies to any coworker with no `role/rituals/` directory.
To make it explicit — or to override the cadence — drop a JSON file
into `coworkers/<name>/role/rituals/`, e.g.:

```json
{
  "name": "reflect.weekly",
  "cadence": { "kind": "weekly", "weekdayUTC": 0, "hourUTC": 3 },
  "action": "reflect",
  "note": "Sunday 03:00 UTC — compact the past week's events into semantic MEMORY.md."
}
```

Once a role adds any file to `role/rituals/`, the full built-in set
(`reflect.weekly`, `journal.daily`, `role.audit`, `health.snapshot`)
is replaced by the on-disk list — so if you want to keep the others,
copy them across too. See `examples/generic-triage/role/rituals/`
for the canonical set.

### Entity evaluator

Opt-in per-tick hook (`src/runtime/evaluator.ts`) that extracts
**people**, **projects**, and durable **workspace facts** from what
the coworker just perceived, thought, and did, and writes them into
the existing filesystem-first stores — no new schema, no new
storage. See [ADR 0006 — filesystem-first storage](docs/adr/0006-filesystem-first-storage.md)
for why entities are markdown files rather than graph edges.

Enable with `EXTRACT_ENTITIES=1` in the coworker's `.env`. Model is
`TRIAGE_MODEL` (if set) else `COWORKER_MODEL` — cheap-first, never a
new required env var. Runs after `deliberate` on every tick; the
prompt is terse and returns empty arrays on uneventful ticks.

Write rules:

- `state/entities/people/<handle>.md` and
  `state/entities/projects/<key>.md` — created if absent with an
  `## auto-generated` heading and the extracted one-liner.
- If the entity file already exists **and** contains the
  `## auto-generated` heading, new one-liners are appended (deduped).
- If the file exists **without** that heading, it is treated as
  human-curated and never touched. Humans have full ownership; the
  evaluator writes only where it has explicit permission.
- Workspace facts append to `state/notes.md` (same shape as
  `memory.note`) tagged `[auto]`, deduped against the tail of the
  file.

Cost + failure are observable: an `evaluator.run` event records
prompt/completion tokens and per-write counts; an `evaluator.error`
event records swallowed failures. The evaluator never crashes the
tick.

---

## Boundaries and dry-run

Every proposed action is checked against `BOUNDARIES.md` before execution.
Rejected actions log `boundary.block` (visible in `highlights.log`) and
never reach the target system.

Default run mode is dry-run: writes return `{dryRun: true, would: {...}}`.
Promote to live per coworker by passing `--live` on the command line.
Watch a coworker in dry-run for a day before granting live access — the
"would" payloads let you verify intent without side effects.

At startup the coworker prints a 3-line ASCII banner announcing **LIVE**
or **DRY-RUN**, sets the terminal window/tab title to
`<name> [LIVE|dry]`, and prefixes every action line in `highlights.log`
with `[LIVE]` or `[dry]`. So the mode is visible from the tab, from the
log tail, and from every write. `bin/aicw status <name>` echoes it too.

`BOUNDARIES.md` also caps resources:

```md
## Resource limits
- Max concurrent worktrees: 0
- Max LLM calls per day: 500
- Max LLM calls per 5h window: 200
```

### Tool field allowlists

Broad MCP tools (e.g. `mcp.linear.update_issue`, which can change title,
description, state, assignee, labels, etc.) can be narrowed to a specific
set of top-level input keys via a `## Tool field allowlist` heading:

```md
## Tool field allowlist
- mcp.linear.update_issue: labelIds
```

Each bullet is `- <tool.name>: <field>[, <field>...]`. At runtime, any call
whose top-level input contains a key outside the list is blocked with
`field '<key>' not in allowlist for <tool>`. The check is shallow: values
under an allowed key are not recursed (the allowlist gates which API surface
the tool touches, not the contents of that surface).

---

## Running the coworker

Foreground:

```bash
node --experimental-strip-types --no-warnings src/index.ts <name>          # dry-run
node --experimental-strip-types --no-warnings src/index.ts <name> --live   # promoted
```

Fleet dashboard:

```bash
node --experimental-strip-types src/dashboard.ts                            # http://127.0.0.1:7777
```

Wake port (if `WAKE_PORT` is set):

```
http://127.0.0.1:<WAKE_PORT>/wake
http://127.0.0.1:<WAKE_PORT>/metrics   # if METRICS_ENABLED=1
http://127.0.0.1:<WAKE_PORT>/webhook/<name>   # per WEBHOOKS.json entry
```

Long-running deployment (unit files, log rotation, restart policy):
[docs/systemd.md](docs/systemd.md).

Multi-machine fleets: [docs/multi-machine.md](docs/multi-machine.md).

### Activity modes

`WAKE_MODE` decides how a coworker learns there's work to do. Read once at
startup; unknown values fall back to `both` with a warning.

| Mode | Periodic tick loop | Wake HTTP server | When to pick it |
|---|---|---|---|
| `tick` | yes | no | Headless-safe polling. Host has no inbound reachability, or you never want to run an HTTP listener. Pays the polling cost every `TICK_INTERVAL_MS`. |
| `webhook` | no (pinned to 24h idle) | yes | Cheapest steady state. Coworker sleeps until a webhook or `/wake` fires; rituals and promises only fire on the resulting tick, so a webhook outage is a liveness outage. Requires `WAKE_PORT`. |
| `both` (default) | yes | yes | Belt-and-suspenders. Webhooks give sub-second reaction, the tick loop is the safety net if webhook delivery breaks. Pick this unless you have a specific reason not to. |

In `webhook` mode the base tick interval is pinned to 24 hours as a
shortcut — the loop still exists, it just doesn't fire on its own. That
means scheduled `rituals/*.json` and pending promises will not fire on
time in `webhook` mode; they fire on the next wake-driven tick. If you
need on-schedule rituals, use `both`.

`wake_mode` composes with the optional [`work_hours`](#work-hours) block:
a coworker can run `wake_mode=both` with `work_hours.out_of_hours=webhook_only`
to get full cadence during working hours and webhook-only quiet outside them.

---

## Verifying it works

Concrete checklist after starting a coworker:

```bash
# 0. One-shot status readout — pid/etime, LIVE-or-DRY-RUN mode, wake port
#    listen state, ticks today, last action, recent sensor errors.
bin/aicw status <name>

# 1. Process is up and ticking
tail -f coworkers/<name>/state/stream.log

# 2. Event log is growing
sqlite3 coworkers/<name>/state/events.db \
  "SELECT ts, kind, substr(payload,1,120) FROM events ORDER BY id DESC LIMIT 20"

# 3. Highlights (thoughts + actions + escalations)
tail -f coworkers/<name>/state/highlights.log

# 4. Wake endpoint responds
curl -X POST http://127.0.0.1:${WAKE_PORT:-7778}/wake

# 5. Webhook endpoint returns 200/202 for a valid signature (401 for a bad one)
curl -v -X POST http://127.0.0.1:${WAKE_PORT:-7778}/webhook/linear \
  -H 'content-type: application/json' -H 'linear-signature: deadbeef' -d '{}'

# 6. Metrics
curl -s http://127.0.0.1:${WAKE_PORT:-7778}/metrics | head

# 7. Service tokens land
bin/aicw verify-slack  <name>
bin/aicw verify-gmail  <name>
# For Linear (MCP OAuth): stream.log should contain
#   "mcp: connected linear (N tools)"
# and coworkers/<name>/state/mcp-tokens/linear.json should exist.

# 8. Tests still pass
npm test
```

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits immediately with LLM auth error | `OLLAMA_API_KEY` unset or wrong endpoint | Set it in root `.env` or `coworkers/<name>/.env`. |
| Every tick is `quiet — skipping` | No sensor sees change, no note, no ritual due. Working as designed. | Leave a note: `bin/note-to.sh <name> "test"`. |
| `boundary.block` in `highlights.log` | Proposed action tripped `BOUNDARIES.md` | Read the block reason; either widen boundaries or fix the coworker's plan. |
| Webhook returns `401` | Signature mismatch — wrong `secretEnv` value, or provider sending a different scheme | Verify `secretEnv` is set and matches the provider's configured secret. Check `stream.log` for the verifier's error. |
| Webhook returns `503` | `secretEnv` referenced in `WEBHOOKS.json` is not set in the process env | Set it in `coworkers/<name>/.env` and restart. |
| Webhook returns `404` | No spec matches that path | Check `WEBHOOKS.json` `path` field vs the URL you're posting to. |
| MCP server "failed to connect" | Bad `command`/`args`, missing npm package, missing env | Try the exact `command + args` outside the harness first. |
| Sensor errors in `stream.log` | Upstream API down or token expired | Re-run the corresponding `bin/verify-*.sh`. |
| Operator note ignored | `NOTE_REQUIRE_SIGNED=1` and note wasn't signed | Set `NOTE_HMAC_SECRET` and use `bin/note-to.sh` (which signs). |

Crash-level errors are written to `coworkers/<name>/state/crash.log`
before the event log is available — check there if the process dies
before writing to `events.db`.

---

## Safety rules for AI agents working on this repo

Read these before touching anything. The previous PR lost hours of live
coworker state because an agent "cleaned up" a scratch directory it had
created inside `coworkers/`. These rules exist to make that impossible
to repeat.

- **Never `git clean`, in any form.** Not `-f`, not `-d`, not `-x`, not
  "just to reset the worktree". If you need a clean state, delete the
  specific files you created, by exact path, one command per file.
- **Never `rm -rf` inside `coworkers/`, `state/`, or any coworker-owned
  directory.** If a specific file must go (a stale `.bak`, an obsolete
  config), delete it by exact path, one file per command — never a
  recursive wildcard.
- **Never create test artifacts inside `coworkers/`.** Test coworker
  directories belong in `/tmp/aicw-test-<random>/`. If you need a
  coworker to test against, copy an example there: `cp -r
  examples/generic-triage /tmp/aicw-test-$$/`. Do not commit anything
  under `coworkers/` from an automated run.
- **Verify with `ls coworkers/` before ending your task.** If any
  coworker directory that existed at the start of your task has
  vanished, STOP IMMEDIATELY and report — do not attempt cleanup or
  recovery, and do not run any further destructive command.
- **If you need to reset a subprocess or worktree, use the specific
  mechanism** (kill by pid, remove a single named file). Never a
  blanket cleanup command.
- **`.env` files are gitignored on purpose** — they are the operator's
  per-machine state. Never delete or regenerate a coworker's `.env`
  without an explicit user instruction naming that file.

If any of these rules conflict with a task instruction, stop and ask.
A lost coworker directory is not recoverable from git.

---

## Contributing / making changes

- Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Tests are non-negotiable — add coverage in `test/` alongside any change
  to `src/`.
- Adding a new webhook signature scheme is a PR to
  `src/runtime/webhook_verifiers.ts` — the closed-set discipline is
  deliberate; don't push scheme selection into role JSON.
- New native tools are a new file under `src/tools/` exporting
  `ToolDef[]`, registered in `src/index.ts`.
- Prefer editing existing role docs / examples over creating new markdown.
- No YAML anywhere.

### For AI agents making commits

- **Never add `Co-Authored-By: Claude` (or any AI-tool trailer) to commit
  messages.** No `Claude-Session:` links. No `Generated with Claude Code`
  footer. These commits are Dan's work; do not attribute them to an AI.
- Commit messages should stand on their own — describe the change and the
  why, not the process that produced them.
- Never push with `--no-verify`, `--force` (except on your own short-lived
  branches), or bypass hooks unless Dan explicitly asks.

---

## Where to read more

- [README.md](README.md) — pitch, tick-loop diagram, adapters table.
- [docs/webhooks.md](docs/webhooks.md) — webhook schema + tunnel setup.
- [docs/systemd.md](docs/systemd.md) — long-running deployment.
- [docs/multi-machine.md](docs/multi-machine.md) — fleets across hosts.
- [docs/dedicated-linear-user.md](docs/dedicated-linear-user.md) — why the Linear identity matters.
- [docs/comparison.md](docs/comparison.md) — vs Hermes / OpenClaw / Eve / ElizaOS / CrewAI / LangGraph etc.
- [docs/tool-cookbook.md](docs/tool-cookbook.md) — patterns for writing native tools.
- [docs/migration.md](docs/migration.md) — porting from other harnesses.
- [docs/release-process.md](docs/release-process.md) — how versions ship.
- [docs/adr/](docs/adr/) — architecture decision records (start with `0001-coala-memory-taxonomy.md`).
- [CHANGELOG.md](CHANGELOG.md) — what changed when.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.
