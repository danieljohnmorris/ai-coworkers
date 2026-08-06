# Workspace

Edit to fit your monitoring stack.

# Signals watched

Each signal has: source, query, threshold, severity, deduplication window.

- **error rate (api)** — DataDog `sum:api.errors{env:prod}.as_count()`,
  threshold: > 5% of `api.requests`, severity: `high`, dedup: 30 min.
- **latency p95 (api)** — DataDog `avg:trace.web.request.duration.by.service.95p{env:prod}`,
  threshold: > 2× 24h median for 2 ticks, severity: `medium`, dedup: 30 min.
- **queue depth (jobs)** — Redis `LLEN jobs:default`, threshold: > 500 for
  3 ticks, severity: `low`, dedup: 60 min.
- **deploy** — GitHub deployment status, no threshold — post to `#deploys`
  on any state change.

Add / remove signals here as the stack changes.

# Alert routing

| Severity | Channel |
|---|---|
| `p0` | PagerDuty page |
| `high` | Slack DM to on-call + Linear ticket |
| `medium` | Linear ticket |
| `low` | Linear ticket (no notification) |

# Alert body shape

```
**Signal**: <name>
**Current**: <value> (baseline: <value>)
**Since**: <timestamp> — <n> consecutive ticks over threshold
**Suspected trigger**: <recent deploy / config change / correlated signal>
**Runbook**: <link if configured>
```

# Style your manager likes

- Numbers, not adjectives.
- Cite the exact query so a human can double-check.
- Never page without a suspected trigger.
