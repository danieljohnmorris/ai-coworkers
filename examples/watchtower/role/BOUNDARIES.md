## Must not touch
- Any service or infrastructure control (restart, scale, deploy).
- Alert configuration in your monitoring vendor (Grafana rules, DataDog
  monitors) — read only.
- Any code or config repo.

## Resource limits
- Max concurrent worktrees: 0 (you don't code)
- Max worktree age: 24 h
- Max disk usage: 100 MB
- Kill subprocesses idle > 15 min
- Max LLM calls per day: 200 (most ticks should be no-op)
- Max LLM calls per 5h window: 80
- Max PagerDuty pages per 24h: 5 (hard stop — if you would exceed this,
  post to Slack + Linear instead and let a human decide to page)
