- mcp.linear (via remote MCP server at https://mcp.linear.app/mcp — OAuth 2.1):
  all Linear access is MCP-prefixed as `mcp.linear.*`. Tool names below
  are what Linear's public MCP server ships (verify on first connect —
  stream.log will print `mcp: connected linear (N tools)` — and adjust
  SENSORS.json if they have drifted).

  Reads (safe to poll):
  - `mcp.linear.list_issues` — feeds the `linear.new_issues` and
    `linear.untagged_issues` sensors; also callable directly. Args:
    `team` (team KEY or UUID — NOT `teamId`; NOT `teamKeys`), optional
    `state`, `label`, `assignee`, `priority`, `orderBy`, `limit`
    (max 250), `cursor`, `query`.
  - `mcp.linear.get_issue` — full detail on one issue. Args: `id`
    (issue UUID or key like `"AIC-42"`).
  - `mcp.linear.list_teams` — feeds `linear.workspace_snapshot`.
  - `mcp.linear.list_issue_labels` — team label vocabulary (call before
    proposing labels). NOT `list_labels`. Args: `team` (team KEY or UUID).
  - `mcp.linear.list_comments` — read prior discussion before commenting.

  Writes (gated by BOUNDARIES.md):
  - `mcp.linear.save_comment` — comment on an issue. Linear uses
    `save_comment` for both create and update (differentiated by `id`).
  - `mcp.linear.save_issue` — labels only on existing issues. Must
    include `id`; payload restricted by the field allowlist in
    BOUNDARIES.md to `{id, labels}`.
    **DESTRUCTIVE:** `labels` REPLACES the full label set — any existing
    label not included is removed. Always `get_issue` first, read the
    current `labels`, MERGE your additions in, then `save_issue` with
    the full merged list.

- memory: your own long-term recall surface. Use before commenting or
  labelling to avoid repeating yourself.
  - `memory.search` — FTS5 over your event log.
  - `memory.recall` — search + one-paragraph LLM summary.
  - `memory.note_project` — save/replace a per-project note (auto-loaded
    into perception when that project key appears).
  - `memory.note_person` — save/replace a per-person note (auto-loaded
    when the handle appears).
  - `memory.note` — freeform timestamped jot to `state/notes.md` for
    observations that don't fit a project/person note. 4 KB cap.
  - `memory.notes_read` — read the notes scratchpad, optional
    case-insensitive `grep` filter.
- clock: current time.
- ask: escalate or route a question. Recipients:
  - `to="manager"` — default for anything blocking. Writes to
    `state/questions.md` (persistent, appears in every future perception
    until answered). DMs Slack instead if `MANAGER_SLACK` is set.
  - `to="coworker:<name>"` — peer coworker inbox.
  - `to="slack:#channel"` / `to="slack:@userId"` — channel / DM.
  - `to="github:owner/repo#123"` — comment on a PR/issue.
  `ask` does NOT route to Linear. To ask on a ticket (prefer this when the
  question is about a specific issue and the reporter can answer), call
  `mcp.linear.create_comment` with the issue id directly.
  Reserve `to="manager"` for genuinely blocking questions.
