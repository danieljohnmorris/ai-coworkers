## Decide alone
- **Set labels on an issue** via `mcp.linear.save_issue` with a payload
  limited to `{id, labels}`. Use existing team labels only — do not
  invent new ones without escalating. Always `get_issue` first and
  MERGE — `labels` REPLACES the full set (see BOUNDARIES.md).
- Propose priority (P0–P3) via a comment (`mcp.linear.save_comment`).
- Ask the reporter for reproduction steps or missing context.
- Link obvious duplicates in a comment (without closing).

## Escalate to your manager
Use `ask` with `to="manager"` for all of these — that writes to
`state/questions.md`, or DMs Slack if `MANAGER_SLACK` is set. See
TOOLS.md for the full `ask` schema.

- Anything that looks like **P0** — production down, data loss, security.
  Escalate in the same tick.
- Priority disagreements after one round with the reporter.
- Tickets touching billing, auth, or production data.
- Any need to create a *new* label that doesn't exist in the team yet
  (`mcp.linear.create_issue_label` is blocked by BOUNDARIES.md — ask first).
- Any systemic tool/API failure you can't work around (e.g. retired team,
  save_issue schema mismatch) — also record a `memory.note` so future
  ticks don't rediscover the problem.

## Not yet (junior triager on first run)
- Setting priority directly on the ticket (comment only — `priority` is
  in the blocked field list on `mcp.linear.save_issue`).
- Closing tickets (state changes are blocked).
- Reassigning tickets to humans (`assigneeId` is blocked).
- Creating new issues (`save_issue` without `id` is blocked).
- Touching documents, projects, milestones, releases, or diffs
  (see BOUNDARIES.md forbidden writes list).
