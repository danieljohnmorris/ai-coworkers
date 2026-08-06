# Give your coworker a dedicated Linear identity

Since the migration to Linear's remote MCP server
(`https://mcp.linear.app/mcp`), auth is OAuth 2.1 with Dynamic Client
Registration — no more static `LINEAR_API_KEY`. Whoever completes the
browser consent on first connect is the identity every subsequent tool
call runs as, until the refresh token is revoked or the cached tokens
are deleted.

That matters for three reasons:

- **Confusing to teammates** — humans can't tell "Dan asked a real
  question" from "Dan's coworker asked an automated question" if both
  post as Dan.
- **Wrong audit trail** — Linear's activity log attributes every
  comment/label change to whoever consented. If you consent as
  yourself, your contribution stats get polluted.
- **Rate-limit collision** — you and the coworker share one quota. A
  chatty coworker can back you out of the API.

## Recommended: consent as a dedicated Linear user

Cheapest, cleanest option:

1. Invite a new member to your Linear workspace with an email you
   control (e.g. `alex@yourcompany.com`, `coworkers+alex@…`).
2. Complete signup as that user in a private browser window.
3. Set their display name to something obviously non-human:
   **Alex (ai-coworker)** or similar.
4. Give them the minimum permissions needed. Most triage coworkers only
   need *Member* on the teams whose issues they'll touch — no admin.
5. Add the Linear MCP server entry to the coworker's `.env` (see the
   [OAuth-based MCP servers section of AGENTS.md](../AGENTS.md#oauth-based-mcp-servers)):

   ```
   MCP_SERVERS='[{"name":"linear","url":"https://mcp.linear.app/mcp","oauth":{"scopes":["read","write"]}}]'
   ```

6. Start the coworker. On first tick it will print an authorization URL
   to stdout. Open it **in a private/incognito browser window logged in
   as the dedicated Linear user** — not your normal browser session —
   and consent.
7. Tokens land at
   `coworkers/<name>/state/mcp-tokens/linear.json` (mode 0600). Every
   future tick reuses them silently.

The Linear activity log will now attribute every action to the
dedicated user, not to you.

## Rotation and revocation

- To force a fresh browser flow (e.g. after changing scopes), delete
  `coworkers/<name>/state/mcp-tokens/linear.json` and restart.
- To revoke the coworker's access entirely, go to Linear **Settings →
  API → Authorized applications** as the dedicated user and revoke the
  ai-coworkers entry.
- Rotating no longer means editing an env var; there is no long-lived
  API key to leak.

## Naming convention that has held up

Give each coworker a first-name identity — Alex, Sam, Watchtower, etc.
— and reference that name in:

- `role/ROLE.md` (the persona)
- The Linear display name of the dedicated user
- Slack (if a bot user exists)
- `/wake` webhook subject headers where applicable

Consistency matters: humans build a mental model of "Alex handles
triage" faster when the same name shows up in every surface.

## What NOT to do

- Don't consent as yourself unless you genuinely want the coworker to
  act *as you* in Linear's audit log.
- Don't share one Linear identity across multiple coworkers. If one
  gets rate-limited or has its refresh token revoked, they all break
  at once.
- Don't give the dedicated user admin permissions. BOUNDARIES.md is
  our defence in depth, but tighter Linear permissions are cheaper
  than a boundary regex that fails open.

## Headless deployments

OAuth-based MCPs are great on interactive workstations and fragile on
headless boxes. A refresh-token rejection at 3am means silent breakage
until an operator opens the printed URL from a machine with a browser.
See the "Headless caveat" in
[AGENTS.md](../AGENTS.md#oauth-based-mcp-servers) for the trade-off.
The current recommendation for headless production is: do the OAuth
consent once on a workstation, copy
`coworkers/<name>/state/mcp-tokens/linear.json` to the headless box,
and hope refresh continues to work.
