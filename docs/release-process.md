# Release process

## Semver stance

We follow semver on the **externally observable behaviour** of a
coworker: role-doc file names + parseable syntax, tool interface
(`ToolDef` shape), adapter contracts (MCP / Hermes / Eve / ACP), env-var
names, on-disk file layout (`coworkers/<name>/state/*`).

- **MAJOR** — break something a running coworker depends on. Renaming a
  role doc, dropping a `ToolDef` field, changing the events.db schema,
  removing an env var. Requires a migration script and an ADR.
- **MINOR** — add a capability. New adapter, new tool primitive, new
  ritual action, new field on an existing shape (with sensible default).
  Backwards-compat is the acid test — an old coworker directory keeps
  working after upgrade with zero edits.
- **PATCH** — bug fix, doc update, test coverage, dep bump that doesn't
  change behaviour.

Internal refactors (module split, file rename in `src/runtime/`) don't
count toward semver. Anyone importing our source directly is on the
edge.

## When to release

Currently ad-hoc. There is no fixed cadence; we release when the
change deserves a version bump. Typical triggers:

- A MAJOR change is ready and stable on `main` for at least a week.
- Enough MINOR changes have accumulated that operators would benefit
  from a documented cut-over.
- A PATCH addresses something broken enough that operators need to
  know quickly (rare — we bias toward "just upgrade from main").

## Cutting a release

1. **Update `CHANGELOG.md`** — move everything under `## [Unreleased]`
   into a new `## [X.Y.Z] - YYYY-MM-DD` section. Group by feat / fix /
   chore / docs / test per the [Log coworker template](../examples/log/role/WORKSPACE.md#changelogmd-shape).
2. **Bump the version in `package.json`.** Semver-appropriate.
3. **Commit as `chore(release): X.Y.Z`.** No functional changes in this
   commit — just the changelog cut + version bump.
4. **Tag:** `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push --tags`.
5. **Draft a GitHub release** with the same body as the CHANGELOG
   entry. Publish once you've eyeballed it.
6. Post-release, add a fresh `## [Unreleased]` header at the top of
   CHANGELOG.md so the next PR has somewhere to write.

Steps 1 and 5 are what the [Log](../examples/log/role/) coworker
automates end-to-end if you deploy it against this repo.

## Version 0.x

Pre-1.0 semver is looser. During 0.x:

- MINOR bumps may break things — we'll call it out in the changelog.
- PATCH bumps still won't break anything.
- We reach 1.0 when the runtime, tool interface, and adapter contracts
  have all been stable for a full quarter with no MAJOR-shaped changes
  landing.

## Deprecation

Two-step: mark deprecated with a runtime warning + doc note in one
release; remove in the release after next (never the immediately
following one — operators need a grace window). Deprecated items log
`note` events with `{ deprecated: <name>, until: "vA.B.C" }` so a
coworker's own health.snapshot ritual surfaces it.

## Migration scripts

Any MAJOR that changes on-disk layout ships a script under
`bin/migrate-<version>.sh` that rewrites an existing coworker
directory in place. Idempotent, backs up to `state/backup-<ts>/` first.
The script's presence and use are documented in the release notes.
