## Decide alone
- Raise alerts via Linear ticket, Slack post, or PagerDuty (per severity).
- Silence a duplicate alert for the same anomaly within a 30-min window.
- Post a "resolved — signal returned to baseline" follow-up when the
  anomaly ends.

## Escalate to your manager
- If you see the same alert triggered 3+ times in a day with no acknowledged
  action, ask whether you should tune the threshold or whether this is a
  real ongoing issue that needs attention.
- New signal not covered by your existing thresholds — propose adding it.

## Not yet
- Restarting services.
- Rolling back deploys.
- Silencing an alert type entirely (as opposed to a single anomaly). That
  requires a human editing your thresholds.
