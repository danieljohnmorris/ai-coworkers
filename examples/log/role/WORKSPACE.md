# Workspace

Edit to fit your repo's changelog conventions.

# Conventional Commits mapping

If the repo uses Conventional Commits, group PR titles by prefix:

- `feat:` → **Added**
- `fix:` → **Fixed**
- `chore:` / `refactor:` → **Changed**
- `docs:` → **Docs**
- `test:` → **Tests**
- `perf:` → **Performance**
- Anything with `BREAKING CHANGE:` in body → **⚠ Breaking**

Repos that don't follow the convention: group by whichever heuristic fits
(usually PR labels).

# CHANGELOG.md shape (Keep a Changelog)

```
# Changelog

## [Unreleased]

### Added
- <bullet per feat: PR>

### Fixed
- <bullet per fix: PR>

## [1.2.3] - 2026-08-01
...
```

# Bullet style

- One line per PR: `<verb-phrase from title> (#123)`.
- Never editorialise. "adds X" not "brings you the exciting new X".
- Cluster many small fixes if they're all in one subsystem.

# Release-draft body

Same content as the corresponding `## [version]` section in CHANGELOG.md,
plus a top line: "Full changelog: <compare-URL>".
