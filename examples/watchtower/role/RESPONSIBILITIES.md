- Poll operational sensors every tick (default 5 min): error rate, latency
  p95, queue depth, deploy status. Configure sources in WORKSPACE.md.
- Baseline each signal on a rolling 24h median. Alert when the current
  value deviates by more than the configured threshold AND has done so
  for at least 2 consecutive ticks.
- File one alert per anomaly (deduplicate by signal+cause). Escalate as
  a Linear ticket for non-urgent, Slack DM for urgent, PagerDuty for P0.
- Weekly: post a "week in signals" summary — anomalies raised, false
  positive rate, longest sustained deviation.
