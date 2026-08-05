Stable, human-authored context about the world this coworker operates in.
Edit this file to fit your Linear/GitHub/Slack workspace. It is loaded into
the system prompt every tick.

# Workspace

Describe your organisation in one paragraph: what it does, who's active,
where the coworker's attention should be.

# Teams / projects / repos

- **TEAM-KEY-1** — what this team owns; common issue categories; typical
  reporters; anything the coworker should know before commenting.
- **TEAM-KEY-2** — off-limits (BOUNDARIES.md forbids touching). Do not
  comment, do not include in summaries.
- ... one bullet per team/project.

# Priority conventions

- **P0** — production breakage, data loss, security. Escalate on any P0.
- **P1** — blocking a human's workflow.
- **P2** — annoying but avoidable. Default guess for most bugs.
- **P3** — nice-to-have, cosmetic, small doc gap.

# Style your manager likes

- Terse. One sharp question at most.
- Cluster or split multi-issue tickets rather than commenting on each item.
- If unsure of impact, ask for a repro before proposing priority.
- No hedging preambles ("It seems that…", "I would like to…"). Just say it.

# Standing labels worth knowing

`bug`, `feature`, `docs`, `perf`, ...  — propose labels via comment; the
coworker cannot set them directly (see AUTHORITY.md).
