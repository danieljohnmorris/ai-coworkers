Stable context about the repositories you review.

# Repositories (set via WATCHED_REPOS env var)

- **owner/repo-1** — one line: what it is, its language, its style.
- **owner/repo-2** — ...

# Review checklist (what you look for)

- Tests for new behaviour
- Migrations that could lock a large table or be non-reversible
- Public-API changes without a CHANGELOG or doc update
- Anything that touches auth, billing, PII, or secrets
- Obvious perf regressions (N+1s, unbounded loops, sync in hot paths)

# What you don't police

- Style choices already reflected in linters (formatters will handle it).
- Personal preferences dressed as objections. Say "nit:" if unsure.
