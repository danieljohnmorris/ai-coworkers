# Changelog

All notable changes to ai-coworkers are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(see [docs/release-process.md](docs/release-process.md) for our semver stance).

## [Unreleased]

### Added
- **Framework-owned baseline prompt** prepended to every coworker's
  system prompt. Covers universal hygiene (tool categories, escalation
  via `ask to="manager"`, memory-note discipline, retry-once tool-failure
  rule, boundary respect, dry-run vs live). Authoritative content at
  `src/runtime/prompts/coworker_baseline.md`; role docs can override any
  `## <kebab-case>` section by declaring the same heading. Existing
  coworkers pick up the baseline on next restart; opt out with
  `COWORKER_SKIP_BASELINE=1`.
- `examples/generic-triage/` refreshed against lessons from live
  triagers: full `ask` recipient list, full memory-tool enumeration,
  post-Linear-MCP-migration tool names (`save_comment`, `save_issue`,
  `list_issue_labels`), `save_issue: id, labels` field allowlist plus
  destructive-labels warning, escalation-with-manager-channel guidance,
  and a doesn't-watch-terminal-live caveat in RELATIONSHIPS.
- `examples/project-manager/`, `examples/trace/`, `examples/watchtower/`
  TOOLS.md top-level bullets updated from pre-migration `linear:` to
  `mcp.linear:` so `BOUNDARIES.md` gating and TOOLS.md hints stay
  aligned with the MCP tool namespace.

### Changed
- **Linear integration migrated to the remote MCP server**
  (`https://mcp.linear.app/mcp`, OAuth 2.1 + DCR). The native
  `src/tools/linear.ts` (and its tests) plus `bin/setup-linear.sh` /
  `bin/verify-linear.sh` have been deleted. Linear is now declarative
  config: an `MCP_SERVERS` entry in `coworkers/<name>/.env` and sensor
  specs in `role/SENSORS.json`. Sensor names (`linear.new_issues`,
  `linear.untagged_issues`, `linear.workspace_snapshot`) are preserved
  so `WEBHOOKS.json` `onEvent.invalidate` targets keep working.

### Removed
- `src/tools/linear.ts`, `src/tools/linear-more.test.ts`,
  `bin/setup-linear.sh`, `bin/verify-linear.sh`.
- `LINEAR_API_KEY`, `LINEAR_IGNORE_TEAMS` env vars.
  `LINEAR_WEBHOOK_SECRET` is retained — webhook auth is independent of
  tool auth.

### Breaking
- Any coworker that used the native `linear.*` tool names (comment,
  set_labels, create_label, issue_detail, team_labels, search) must
  migrate to the MCP-prefixed equivalents (`mcp.linear.create_comment`,
  `mcp.linear.update_issue`, `mcp.linear.get_issue`,
  `mcp.linear.list_labels`, `mcp.linear.list_issues`). See
  `coworkers/alex-triage/role/{TOOLS,BOUNDARIES,AUTHORITY}.md` for the
  updated mapping and boundary rules (in particular:
  `mcp.linear.update_issue` must be gated to labelIds-only payloads to
  preserve the "labels + comments only" contract).

## [0.1.0] - 2026-08-06

Initial public-shape release. All notable features from prior internal
work rolled up. Not yet promoted to 1.0 — the runtime + tool interface +
adapter contracts are stable in practice but may still shift; see
`docs/release-process.md`.

### Added — Runtime
- Long-running tick loop with sense → perceive → deliberate → act cycle.
- **Roles** as filesystem directories (`role/ROLE.md`, `RESPONSIBILITIES.md`,
  `AUTHORITY.md`, `BOUNDARIES.md`, `RITUALS.md`, `RELATIONSHIPS.md`,
  `TOOLS.md`, `WORKSPACE.md`).
- **Six-tier memory taxonomy** (working / episodic / semantic / entity /
  procedural / reflective) — see [ADR 0001](docs/adr/0001-coala-memory-taxonomy.md).
- **Boundary regex checks** pre-execute; dry-run default.
- **Quiet gate + adaptive tempo** — skip LLM entirely on unchanged perception.
- **Cheap-first triage** preflight via `TRIAGE_MODEL` env.
- **LLM-driven compaction** of oversized prior-step outcomes.
- **Rate-limit awareness** — track 429s per external service prefix.
- **Prompt-level PII masking** of cloud identifiers (opt-in `PII_MASK=1`).
- **Signed inbox notes** via HMAC-SHA256; unsigned notes tagged `[UNSIGNED]`.
- **Reactions log** — human 👍/👎 feedback surfaced once in the next tick.
- **Role-doc drift audit** as a scheduled ritual.
- **Declarative rituals** loaded from `role/rituals/*.json`.
- **Per-coworker `.env`** scoping (each coworker isolated from shell env).
- **Reflect (weekly dream)** — LLM-compacted learnings with `[ev:id,...]`
  provenance citations, walkable via `bin/why.sh`.

### Added — Adapters
- **MCP** (Model Context Protocol) — expose any MCP server as coworker tools.
- **Hermes** — load Nous Research skills as procedural memory (recursive scan).
- **Vercel Eve** — surface `agent/`-shape tools (executable-adapter gap
  documented in `src/adapters/eve.ts`).
- **ACP** (Agent Client Protocol) — spawn Goose / Codex / Claude Code
  as `code.delegate`, sandboxed via bwrap/firejail (see [ADR 0002](docs/adr/0002-acp-code-delegate.md),
  [ADR 0003](docs/adr/0003-container-isolation.md)).
- **Linear webhook** — HMAC-verified `/linear-webhook` on the wake server.

### Added — Tools
- `linear.*` — read/comment/label/search Linear issues.
- `slack.*` — post/DM/mentions.
- `github.*` — read PRs, comment.
- `ask` — route questions to manager / peer / slack / linear / github.
- `memory.*` — semantic + entity note tools.
- `role.propose_change` — coworker files a proposal to edit its own role
  docs; human approves via `bin/review-proposal.sh`.
- `branch.note` / `branch.read` / `branch.list` — per-branch narrative files.
- `code.delegate` — hand off to any ACP-conformant coding agent.
- `gmail.*` — shells out to Hermes google_api.py with per-coworker OAuth.

### Added — Security
- **Injection scanner** with homoglyph normalisation, zero-width strip,
  indirect-injection heuristics (base64 diversity, data URLs, long lines).
- **Credential broker** — tools declare `requiresCreds`; runtime filters env.
- **Secret redaction** at persistence + transport boundaries — same pattern
  library as the git pre-commit hook.
- **Pre-commit hook** blocking any staged file containing a credential-shape.
- **Subprocess sandboxing** (bwrap/firejail) for the ACP delegated agent.

### Added — Operator CLI (`bin/`)
- `new-coworker.sh` / `new-coworker-interview.sh` — scaffold a coworker.
- `import-{hermes,openclaw,eve}.sh` — migrate an existing agent.
- `note-to.sh` — leave a note (with optional HMAC signing).
- `answer.sh` — answer a persistent question.
- `react.sh` — 👍/👎 reinforcement signal.
- `review-proposal.sh` — accept/reject role-change proposals.
- `audit-accept.sh` — advance the role-audit snapshot after review.
- `test-role.sh` — preview role-doc changes without deploying.
- `why.sh` — walk from a MEMORY.md citation back to source events.
- `relate.sh` — record RELATIONSHIP edges between entities.
- `search.sh` — cross-coworker FTS5 search.
- `setup-{gmail,slack,linear}.sh` + `verify-{gmail,slack,linear}.sh` —
  per-coworker per-service setup + smoke test.
- `bench-events-db.mjs` — SQLite contention benchmark.
- `cost-report.sh` — per-model USD via `pricing.json`.
- `scan-secrets.mjs` — pre-commit + full-history secret scan.

### Added — Docs
- 5 ADRs covering memory taxonomy, ACP adoption, sandboxing, events.db
  design, evaluators+services roadmap.
- Migration matrix for Hermes / OpenClaw / Eve.
- Tool cookbook (Hermes / MCP / native decision tree).
- Multi-machine deployment guide.
- Dedicated Linear identity setup guide.
- Release process + semver stance.
- Auto-deployed mkdocs site.
- `llms.txt` + `llms-full.txt` for LLM-facing discoverability.

### Added — Testing
- 518+ tests across unit + integration + behaviour-eval scenarios.
- ~99.8% line coverage.
- Scored SRE benchmark harness (real-LLM-driven) with 3 initial scenarios.

### Security posture
- Zero secrets in git history (verified via `bin/scan-secrets.mjs --history`).
- Pre-commit hook installed via `git config core.hooksPath .githooks`.
- All external identifiers can be masked pre-LLM via `PII_MASK=1`.

[Unreleased]: https://github.com/danieljohnmorris/ai-coworkers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danieljohnmorris/ai-coworkers/releases/tag/v0.1.0
