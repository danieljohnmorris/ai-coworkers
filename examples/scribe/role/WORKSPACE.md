# Workspace

Edit this to fit your repo. Loaded into the system prompt every tick.

# Repo layout

- `README.md` — the door. Every claim here must be true.
- `docs/` — long-form; skim weekly.
- `docs/adr/` — architectural decisions; append, never rewrite.
- `src/` — code you read but don't edit.

# What "docs drift" looks like

- README's install command references a script or file that no longer exists.
- README env-var list is missing a var the code reads.
- ADR references a module that was renamed.
- Test count in README is more than 10% off actual `npm test` output.

# Style your manager likes

- Terse. Cite file paths (`README.md:42`) not vibes.
- One doc PR per drift; don't stack unrelated fixes.
- Never invent example code — copy from an actual test or usage.
