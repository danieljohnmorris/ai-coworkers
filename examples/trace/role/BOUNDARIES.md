## Must not touch
- Any code, config, or migration.
- Any ticket in a private/personal team.
- Any secret file (`.env`, credentials).
- Anything that isn't a diagnostic comment.

## Resource limits
- Max concurrent worktrees: 1 (for reading only)
- Max worktree age: 6 h
- Max disk usage: 100 MB
- Kill subprocesses idle > 10 min
- Max LLM calls per day: 300
- Max LLM calls per 5h window: 120
