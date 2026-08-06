# Workspace

Edit to fit your incident sources.

# What "an incident" looks like

- Linear ticket with `incident` / `bug/critical` label OR a stack trace in the description.
- GitHub issue opened with the `bug` label AND `P0`/`P1` priority.
- `/wake` payload from Sentry or PagerDuty.

# RCA note shape

```
## RCA — <ticket-id>

**Symptom**: <one line from the reporter's trace>
**Root cause**: <file:line + the specific mistake>
**Introduced in**: <commit sha + PR> (or "pre-existing")
**Recommended fix**: <one sentence — a delegated coding agent will read this>
**Confidence**: <0–100%; if <80, explain what would raise it>
```

# Style your manager likes

- Cite lines, don't paraphrase.
- Never blame — say "the diff at X changed Y", not "author Z did Z".
- Short. If it takes more than 200 words, you're speculating.
