# Contributing

Thanks for looking. Two guiding rules before you start:

1. **The tick loop's job is deciding when NOT to act.** Every feature
   proposal should have a clear answer to "does this make the coworker
   quieter, or louder?" We accept louder-in-service-of-a-real-need; we
   reject louder-for-its-own-sake.
2. **The filesystem is the API.** Config goes in `role/*.md`, state in
   `state/`. If your feature needs a new runtime concept, prefer a new
   markdown file or json file over a new env var; prefer a new env var
   over a new runtime flag; prefer a new runtime flag over changing
   the tool interface.

## Development setup

Requires Node ≥ 22 (uses native `node:sqlite`, `--experimental-strip-types`).

Use the npm version pinned in `package.json#packageManager`. Older npm does
not understand the `libc` field and strips the glibc/musl gating from
optional dependencies on every `npm install`, which silently breaks installs
on Alpine. CI regenerates the lockfile and fails on any difference.

```bash
git clone https://github.com/danieljohnmorris/ai-coworkers
cd ai-coworkers
npm i -g "npm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
npm install
npm test              # 733 tests, ~3s
npm run test:cov      # ~98% line coverage

# Enable the pre-commit hook that blocks accidental secret commits:
git config core.hooksPath .githooks
```

The pre-commit hook runs `bin/scan-secrets.mjs --staged` and blocks the
commit if any staged file matches a credential-shape (Bearer tokens,
Linear `lin_api_*`, Slack `xoxb-*`, GitHub `ghp_*`, Anthropic `sk-ant-*`,
OpenAI `sk-*`, AWS `AKIA*`, Google `AIza*`, PEM private keys). You can
also run it ad-hoc:

```bash
node --experimental-strip-types --no-warnings bin/scan-secrets.mjs --tree     # all tracked files
node --experimental-strip-types --no-warnings bin/scan-secrets.mjs --history  # every blob ever
```

If a real secret ever lands in git: rotate at the source *first*, then
purge from history with [git-filter-repo](https://github.com/newren/git-filter-repo).
Never rely on `git rm` alone.

## Running a coworker locally

```bash
# Blank template
bin/new-coworker.sh myworker

# Edit myworker/role/*.md — at minimum ROLE.md, RESPONSIBILITIES.md,
# BOUNDARIES.md. See examples/generic-triage/role/ for a working set.

# Dry-run first (default): writes return {dryRun: true, would: {...}}
node --experimental-strip-types --no-warnings src/index.ts myworker

# When you trust it, add --live
```

## Making a change

### Small — bugfix, doc tweak, one obvious feature

1. Branch from `main`, one topic per branch.
2. Add or update tests. Fix ratio: at least one new test per new
   behaviour; failing test-first is preferred for bugfixes so we know
   the regression stays fixed.
3. Run the full suite: `npm test`. Coverage must not drop.
4. Commit with a message that explains the *why* in the body, not just
   the *what*. See `git log --oneline` for house style — every commit
   answers "why did this change need to happen?" not just "what did I
   change?".
5. Open a PR. Squash-merge when green.

### Bigger — new subsystem, architectural change, protocol adoption

1. Open an issue OR draft a PR first — tell us what you're building.
2. If the change deserves a design artifact, add an ADR under
   `docs/adr/000N-my-change.md` following the existing shape (context,
   options, decision, consequences).
3. Land the ADR in a separate PR before the implementation. Reviewers
   want to disagree with your design *before* you write 800 lines of
   code around it.

## Coding conventions

Read a handful of existing files (`src/runtime/tick.ts`,
`src/runtime/reflect.ts`, `src/tools/github.ts`) and match that style.
Notable choices:

- **TypeScript, no build step** — `--experimental-strip-types` runs
  `.ts` directly. No transpilation, no bundler, no webpack.
- **Node built-ins first** — we ship `node:sqlite`, `node:crypto`,
  `node:http`. Add a dependency only when the alternative is
  substantially worse (we currently ship 3 runtime deps).
- **Every module owns its own file** — no barrel imports, no
  `src/index.ts` re-exports for internal boundaries. `import { x }
  from "./thing.ts"` explicitly.
- **Tests colocated** — `src/runtime/x.ts` has `src/runtime/x.test.ts`.
  Integration scenarios live under `test/`.
- **JSON schema for tool inputs** — every `ToolDef.inputSchema` is a
  real schema. `validateInput` runs before boundary checks.
- **Comments explain WHY not WHAT** — the code says what; the comment
  says why *this* way over the obvious alternatives.
- **No emoji in code / commits** unless it's a UI thing (stream
  highlights, help output). Comments and identifiers stay plain.

## What we won't merge

- Silent behaviour changes to a running coworker (needs a boundary
  check, a role-audit signal, or an ADR — depending on scope).
- Anything that lowers coverage below 90% without an ADR justifying why.
- A "clever" tool that could be a Hermes skill or an MCP server (see
  `docs/tool-cookbook.md`).
- Dependencies whose purpose we can't articulate in one sentence.

## About `AIC-*` references in git history

You'll see commit messages like `feat(AIC-82): …`. These are the
maintainer's internal Linear ticket IDs and **are not clickable from
GitHub**. Treat them as historical metadata — you don't need access
to any Linear workspace to work on the repo. If you want an issue to
work against, use [GitHub Issues](../../issues) (templates at
`.github/ISSUE_TEMPLATE`).

## Reporting a bug

Include:
- Node version.
- A minimal `role/*.md` set that reproduces.
- Relevant slice of `state/highlights.log` (redact anything sensitive).
- What you expected vs what happened.

Do NOT paste API keys or `.env` contents into an issue. Same rule as
your own memory: reference by env var name.

## Security

If you find a security issue (boundary bypass, injection scanner miss,
subprocess escape), don't file a public issue. Email the maintainer
at daniel.john.morris@gmail.com with steps to reproduce.
