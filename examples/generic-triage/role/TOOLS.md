- linear (via remote MCP server at https://mcp.linear.app/mcp — OAuth 2.1):
  registered as `mcp.linear.*`. Tool names below are what Linear's public
  MCP server ships (verify on first connect and adjust SENSORS.json if
  they have drifted).

  Reads:
  - `mcp.linear.list_issues` — feeds the `linear.new_issues` and
    `linear.untagged_issues` sensors; also callable directly.
  - `mcp.linear.get_issue` — full detail on one issue.
  - `mcp.linear.list_teams` — feeds `linear.workspace_snapshot`.
  - `mcp.linear.list_labels` — team label vocabulary.

  Writes (gated by BOUNDARIES.md):
  - `mcp.linear.create_comment` — comment on an issue (dry-run until promoted).

- memory: search your own past events (memory.search) — use before commenting to avoid repeating yourself.
- clock: current time.
