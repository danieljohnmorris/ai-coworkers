- mcp.linear: create alert tickets via `save_issue` (severity via label),
  comment as anomaly evolves via `save_comment`. Access is via the
  remote MCP server at https://mcp.linear.app/mcp (OAuth 2.1). Gate
  destructive fields via BOUNDARIES.md.
- slack: post to `#alerts` for medium severity.
- ask: escalate ambiguous thresholds to your manager.
- memory: track open anomalies + your rolling baselines so you can
  deduplicate and post updates instead of fresh alerts.
- (Optional) MCP servers wired to Grafana / DataDog / Prometheus for the
  actual signal reads — configure via MCP_SERVERS.
