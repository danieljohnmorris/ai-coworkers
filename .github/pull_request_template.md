<!--
Read CONTRIBUTING.md before opening a PR — it defines the two guiding
rules every change is measured against. Delete the sections below that
don't apply.
-->

## Summary

<!-- One sentence: what does this change do? Not why — the body covers that. -->

## Why

<!-- The problem this solves. Link an issue if one exists. -->

## How

<!-- The shape of the change. If it's touching a subsystem, name it (tick.ts, credentials.ts, adapters/*, etc.). -->

## Test plan

- [ ] `npm test` passes locally
- [ ] `npm run test:cov` — coverage did not drop
- [ ] `bin/scan-secrets.mjs --staged` — no accidental credential-shape (the pre-commit hook enforces this too, but confirm you have `git config core.hooksPath .githooks` set)
- [ ] Added or updated tests for the new behaviour
- [ ] Updated relevant docs (README, docs/*.md, ADR, or CHANGELOG)

## Checklist for bigger changes

- [ ] If this changes a role-doc contract, boundary format, or on-disk layout, there's an ADR under `docs/adr/`
- [ ] If this adds a new external dependency, the "add a dep only when the alternative is substantially worse" rule applies — say what you tried without it
- [ ] If this affects the runtime cost story (LLM calls, disk writes, budgets), quantify the delta
