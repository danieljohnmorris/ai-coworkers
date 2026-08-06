# Give your coworker a dedicated Linear identity

By default `LINEAR_API_KEY` uses your personal Linear API key, which
means every ticket comment the coworker posts shows up under your name.
Bad on three axes:

- **Confusing to teammates** — humans can't tell "Dan asked a real
  question" from "Dan's coworker asked an automated question".
- **Wrong audit trail** — Linear's activity log attributes everything
  to you, so your prior-year contribution stats are polluted.
- **Rate-limit collision** — you and the coworker share one quota. A
  chatty coworker can back you out of the API.

## Set up a service account (Linear seats permitting)

Cheapest, cleanest option:

1. Invite a new member to your Linear workspace with an email you
   control (e.g. `alex@yourcompany.com`, `coworkers+alex@…`).
2. Complete signup as that user in a private browser window.
3. Set their display name to something obviously non-human:
   **Alex (ai-coworker)** or similar.
4. Give them the minimum permissions needed. Most coworkers only need
   *Member* on the teams whose issues they'll touch — no admin.
5. As that user, go to **Settings → API → Personal API keys**, generate
   a key, copy the value into `~/.bashrc` as `LINEAR_API_KEY` (or your
   coworker's `.env`).

## Set up a Linear OAuth app (if you can't add a seat)

If your Linear plan is at the seat limit or you want the coworker to
act across multiple workspaces:

1. **Settings → API → OAuth applications → New**.
2. Redirect URL: your coworker's `/wake` endpoint (or any callback you
   own; the token only needs to be captured once).
3. Scopes: `read`, `write` (the current tools need issue read/write and
   comment create).
4. Do the OAuth dance once; store the resulting access token as
   `LINEAR_API_KEY`.

OAuth tokens show up in Linear's activity log under the app's name, not
under any human, which is usually the right behaviour for a bot.

## Naming convention that has held up

Give each coworker a first-name identity — Alex, Sam, Watchtower, etc.
— and reference that name in:

- `role/ROLE.md` (the persona)
- The Linear display name of the service account
- Slack (if a bot user exists)
- `/wake` webhook subject headers where applicable

Consistency matters: humans build a mental model of "Alex handles
triage" faster when the same name shows up in every surface.

## What NOT to do

- Don't share one Linear API key across multiple coworkers. If one
  gets rate-limited or has to be rotated, they all break at once.
- Don't give the service account admin permissions. Boundaries.md is
  our defence in depth, but tighter Linear permissions are cheaper
  than a boundary regex that fails open.
- Don't skip the display name. `LINEAR_API_KEY user 3` posting on
  every ticket is exactly the "who is this bot and why is it
  commenting" complaint you'll get from your team.

## Rotation

`bin/why.sh` doesn't include the API key it hits — safe to share.
Nothing in this repo persists the key beyond your `.env`. Rotate by
generating a new key in Linear settings, updating `.env`, and
restarting the coworker. Old key becomes invalid immediately.
