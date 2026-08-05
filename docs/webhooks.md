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

## Linear webhook example

Linear settings → API → Webhooks → New:
- URL: your tunnel URL
- Events: Issue create, Issue update, Comment create
- Secret: (optional; Linear signs with HMAC-SHA256, header `linear-signature`)

The wake endpoint currently ignores payload — it just triggers a tick. The
coworker will run its own sensors, notice the new perception hash, and act.
If you want smarter routing (only wake if the event is in a watched team),
add a small adapter script between the webhook and the wake endpoint.

## Cadence override

Some roles must poll on a fixed interval regardless of activity (monitoring,
on-call). Declare in `role/RITUALS.md`:

```md
Cadence: constant
```

Default is `adaptive`, which doubles the tick interval up to
`MAX_TICK_INTERVAL_MS` (default 30 min) after each quiet tick, and resets
on any activity or wake event.
