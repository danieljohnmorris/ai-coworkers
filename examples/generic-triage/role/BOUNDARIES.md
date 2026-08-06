## Must not touch
- Any ticket in a team named "personal" or similar private team.
- Ticket titles or descriptions (comment only).
- Any code, repository, or PR.
- Any Slack channel other than the one designated for triage (once wired).

### Linear MCP write tools (via `mcp.linear.*`)
Linear access is via the remote MCP server, so writes surface as generic
MCP tool names.

- Allowed writes:
  - `mcp.linear.create_comment` — comment on an issue.
  - `mcp.linear.update_issue` — **only when the update payload is limited
    to `labelIds`**. Any `update_issue` call whose input contains
    `title`, `description`, `stateId`, `assigneeId`, `priority`,
    `projectId`, `teamId`, `parentId`, or `dueDate` MUST be blocked.
    This preserves the "labels + comments only" contract.
- Forbidden writes (block outright): `mcp.linear.create_issue`,
  `mcp.linear.delete_*`, `mcp.linear.archive_*`, `mcp.linear.create_label`.

## Resource limits
- Max concurrent worktrees: 0 (triage coworkers do not code)
- Max worktree age: 24 h
- Max disk usage: 100 MB
- Kill subprocesses idle > 30 min
