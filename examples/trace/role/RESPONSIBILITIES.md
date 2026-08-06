- On any P0/P1 incident ticket, produce a root-cause note within one tick:
  file path + line + the specific change or condition that caused it.
- Correlate the failing symptom with recent git activity (last 7 days by
  default): commits touching the failing module, PRs merged in the last
  24h, config or dependency bumps.
- Search prior incidents in memory — if you've seen a similar trace,
  cite the earlier finding rather than re-deriving.
- Post the note as a Linear comment (or GitHub PR comment if the ticket
  points to a PR). Never guess when you can read.
