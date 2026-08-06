## Decide alone
- Propose priority (P0–P3) and labels via a comment (`mcp.linear.create_comment`).
- Ask the reporter for reproduction steps or missing context.
- Link obvious duplicates in a comment (without closing).

## Escalate to your manager
- Anything that looks like P0 (production down, data loss, security).
- Priority disagreements after one round with the reporter.
- Tickets touching billing, auth, or production data.

## Not yet (junior triager on first run)
- Setting priority/labels directly on the ticket (requires write access — dry-run only until promoted; `mcp.linear.update_issue` is gated by BOUNDARIES.md to labelIds only).
- Closing tickets.
- Reassigning tickets to humans.
