## Must not touch
- Any ticket in a team named "personal" or similar private team.
- Ticket titles or descriptions (labels + comments only).
- Any code, repository, or PR.
- Any Slack channel other than the one designated for triage (once wired).
- Do not invent new labels — only apply labels that already exist in the
  team's label vocabulary (call `mcp.linear.list_issue_labels` first).

### Linear MCP write tools (via `mcp.linear.*`)
Linear access is via the remote MCP server, so writes surface as generic
MCP tool names. Linear's `save_*` tools do both create and update —
differentiated by whether `id` is present in the payload. The gating
rules below rely on the field allowlist to enforce that.

- Allowed writes:
  - `mcp.linear.save_comment` — comment on an issue.
  - `mcp.linear.save_issue` — **only when the payload contains `id` and
    is limited to `labels` (label maintenance on an existing issue)**.
    Any `save_issue` call whose input contains `title`, `description`,
    `stateId`, `assigneeId`, `priority`, `projectId`, `teamId`,
    `parentId`, or `dueDate` MUST be blocked. Any `save_issue` call
    without `id` (i.e. a create) MUST be blocked.
- Forbidden writes (block outright):
  - `mcp.linear.delete_*`, `mcp.linear.archive_*`
  - `mcp.linear.create_issue_label` (unless a manager explicitly
    approved a new label via `ask`).
  - `mcp.linear.save_document`, `mcp.linear.save_project`,
    `mcp.linear.save_milestone`, `mcp.linear.save_release`,
    `mcp.linear.save_release_note`, `mcp.linear.save_status_update`.
  - `mcp.linear.merge_diff`, `mcp.linear.submit_diff_review`,
    `mcp.linear.save_diff_comment`, `mcp.linear.resolve_diff_thread`,
    `mcp.linear.delete_diff_comment` — code review is not a triager's job.

## Tool field allowlist
Machine-parseable field restrictions (enforced by `src/runtime/boundaries.ts`
`checkAction`). Any top-level input key outside the list causes the call to
be blocked with `field '<key>' not in allowlist for <tool>`.

- `mcp.linear.save_issue`: id, labels

**DESTRUCTIVE-label warning:** `labels` on `save_issue` REPLACES the full
label set on the issue. Always `get_issue` first to read the current
labels, merge in your additions, then send the full merged list — never
send a bare additions-only array.

## Resource limits
- Max concurrent worktrees: 0 (triage coworkers do not code)
- Max worktree age: 24 h
- Max disk usage: 100 MB
- Kill subprocesses idle > 30 min
