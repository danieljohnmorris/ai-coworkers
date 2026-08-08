# BOUNDARIES.md — example governance policy

This file demonstrates each rule type parsed by `hermes-governance`.
Delete or edit sections to fit your own project; the plugin ignores
unknown headings and malformed bullets.

## Must not touch

- production
- billing-service
- /etc/shadow
- coworkers/alex-triage

## Tool field allowlist

- mcp.linear.update_issue: labelIds, comment
- write_file: path, content
- terminal: command

## Resource limits

- Max LLM calls per day: 500
- Max LLM calls per 5h window: 200
- Max concurrent worktrees: 0
