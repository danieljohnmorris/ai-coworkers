# Changelog

All notable changes to ai-coworkers are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(see [docs/release-process.md](docs/release-process.md) for our semver stance).

## [Unreleased]

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
