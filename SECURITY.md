# Security Policy

## Reporting a vulnerability

If you find a security issue in ai-coworkers, **do not open a public
issue**. Instead, email the maintainer directly:

**daniel.john.morris@gmail.com**

Include:

- A clear description of the issue.
- Steps to reproduce (a minimal repro is worth more than any writeup).
- What you were expecting vs. what happened.
- Your assessment of the severity + attack scenario, if you have one.

You should receive an acknowledgement within **72 hours**. If you
haven't, please resend — spam filters happen.

## What counts as a security issue

- Anything that lets a coworker execute outside its declared boundaries
  (regex bypass, JSON escape, prompt-injection-driven scope escalation).
- Any leak of credentials — from `.env`, from `process.env`, from tool
  handlers, from persisted events.
- Any subprocess escape from the `bwrap`/`firejail` sandbox wrappers
  (see [ADR 0003](docs/adr/0003-container-isolation.md)).
- Any injection-scanner miss (see [`src/runtime/injection.ts`](src/runtime/injection.ts))
  that would let untrusted third-party text act as instructions the
  model treats as trusted.
- Any git-side leak: a secret pattern the pre-commit hook fails to
  catch (see [`bin/scan-secrets.mjs`](bin/scan-secrets.mjs)).

## Disclosure timeline

- **Day 0:** you send the report.
- **≤ 72h:** we acknowledge.
- **≤ 30d:** we ship a fix, or explain why the timeline needs to slip.
- **After fix:** we publish a security advisory + coordinate with you
  on public disclosure. You get credit unless you'd prefer not to be
  named.

## Supported versions

Pre-1.0, only `main` is supported. There is no LTS branch. If you're
running from a commit and hit a security issue, upgrade to current
`main` first — the fix may already have shipped.

## Related

- [ADR 0003 — subprocess sandboxing + container isolation](docs/adr/0003-container-isolation.md)
- [AIC-50 — injection scanner beyond regex](https://linear.app/ilo-lang/issue/AIC-50) *(internal ticket)*
- [AIC-74 — credential broker](https://linear.app/ilo-lang/issue/AIC-74) *(internal ticket)*
- [AIC-85 — secret hygiene (pre-commit + runtime redaction)](https://linear.app/ilo-lang/issue/AIC-85) *(internal ticket)*
