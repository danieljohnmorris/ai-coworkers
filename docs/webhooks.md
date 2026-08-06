# Event-driven wake-ups

Coworkers poll on a tick interval by default. For sub-second reaction to real
events (a new Linear issue, a Slack mention, a fresh PR), enable the wake
endpoint and point a webhook at it.

## Enable

Add to your `.env`:

```
WAKE_PORT=7778           # per-coworker port; pick unique ones for a fleet
WAKE_SECRET=some-shared-secret   # optional; enables 0.0.0.0 binding + auth
```

On startup the coworker logs:
```
[hh:mm:ss] alex-triage wake endpoint: http://127.0.0.1:7778/wake
```

## Test

```
curl -X POST http://127.0.0.1:7778/wake
```

You should see in the coworker's stream:
```
woken by event — next tick immediately
```

## Real webhook wiring

### Local dev — smee.io tunnel

`smee.io` gives you a public URL that forwards to your localhost.

```
npm install -g smee-client
smee -u https://smee.io/YOUR_CHANNEL -t http://127.0.0.1:7778/wake
```

Point Linear/Slack/GitHub webhooks at `https://smee.io/YOUR_CHANNEL`.

### Production — real tunnel

Use Cloudflare Tunnel, Tailscale Funnel, or similar to expose the wake port.
Always set `WAKE_SECRET` and configure the webhook provider to send it as an
`x-wake-secret` header (or use their signing scheme + a small adapter).

## Linear webhook — native adapter (AIC-36)

Point Linear at `POST /linear-webhook` on the same `WAKE_PORT`; the runtime
verifies the HMAC signature, filters by team, and wakes only on matching
events.

Env:

```
LINEAR_WEBHOOK_SECRET=<same secret Linear signs with>
LINEAR_WATCHED_TEAMS=ILO,AIC    # optional; unset = accept every team
```

Linear settings → API → Webhooks → New:
- URL: `https://your-tunnel/linear-webhook`
- Events: Issue create, Issue update, Comment create
- Secret: whatever you set as `LINEAR_WEBHOOK_SECRET`

Return codes:
- `200` — signature valid, team matched, coworker woken.
- `202` — signature valid, team NOT in `LINEAR_WATCHED_TEAMS`; ack, no wake.
- `401` — missing / bad signature.
- `503` — `LINEAR_WEBHOOK_SECRET` not set on the coworker's side.

Setting `LINEAR_WEBHOOK_SECRET` also binds the wake server to `0.0.0.0`
so the tunnel can reach it, whether or not `WAKE_SECRET` is also set.

## Generic wake fallback

If you'd rather route webhooks yourself (Slack Events API, GitHub with a
custom signature scheme, an internal event bus), keep using `POST /wake`
— verify the signature in your intermediary and trigger a bare wake. The
coworker's sensors will pick up whatever changed.

## Cadence override

Some roles must poll on a fixed interval regardless of activity (monitoring,
on-call). Declare in `role/RITUALS.md`:

```md
Cadence: constant
```

Default is `adaptive`, which doubles the tick interval up to
`MAX_TICK_INTERVAL_MS` (default 30 min) after each quiet tick, and resets
on any activity or wake event.
