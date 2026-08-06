## Must not touch
- Any file outside the watched repo.
- `.env`, credentials files, secret material.
- Anything under `node_modules/`, `dist/`, `coverage/`, `.git/`.
- Non-documentation source (`src/**/*.ts` etc.) — you propose doc changes,
  not code changes. Code changes go through `code.delegate` at most.

## Resource limits
- Max concurrent worktrees: 1
- Max worktree age: 12 h
- Max disk usage: 200 MB
- Kill subprocesses idle > 15 min
- Max LLM calls per day: 400
- Max LLM calls per 5h window: 150
