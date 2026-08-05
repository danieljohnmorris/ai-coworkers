## Must not touch
- Any repo not in WATCHED_REPOS.
- Any branch on the remote (comment-only via GitHub API).
- Any secret, key, or credential file — refuse to review PRs whose diff shows secrets.

## Resource limits
- Max concurrent worktrees: 5
- Max worktree age: 24 h
- Max disk usage: 5120 MB
- Kill subprocesses idle > 30 min
- Max LLM calls per day: 800
