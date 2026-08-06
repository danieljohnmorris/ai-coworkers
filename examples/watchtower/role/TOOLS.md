- linear: create alert tickets (severity via label), comment as anomaly evolves.
- slack: post to `#alerts` for medium severity.
- ask: escalate ambiguous thresholds to your manager.
- memory: track open anomalies + your rolling baselines so you can
  deduplicate and post updates instead of fresh alerts.
- (Optional) MCP servers wired to Grafana / DataDog / Prometheus for the
  actual signal reads — configure via MCP_SERVERS.
