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

## Disabling the periodic tick — `WAKE_MODE=webhook`

By default the coworker runs both the wake HTTP server AND the periodic
tick loop (`WAKE_MODE=both`). If you want the cheapest steady state and
trust your webhook coverage, set:

```
WAKE_MODE=webhook
WAKE_PORT=7778
```

This disables the scheduled tick loop (the base interval is pinned to
24h). Ticks then fire only on `/wake`, on matching `/webhook/*` calls,
and at startup — webhook delivery becomes the ONLY liveness signal.
Missed webhooks mean silent drift. Scheduled `rituals/*.json` and pending
promises only run when a wake event happens to fire a tick; they do not
fire on time.

Belt-and-suspenders operators want `WAKE_MODE=both` (the default) so a
webhook outage degrades into normal polling instead of silent inactivity.
Use `WAKE_MODE=tick` on hosts with no inbound reachability.

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
smee -u https://smee.io/YOUR_CHANNEL -t http://127.0.0.1:7778/webhook/linear
```

Point the Linear webhook at `https://smee.io/YOUR_CHANNEL` (the `-t`
target on the smee-client is the specific path from your
`WEBHOOKS.json`, e.g. `/webhook/linear`, `/webhook/github`,
`/webhook/slack`). Run one smee-client per webhook path, or use a real
tunnel (below) if you want one public URL to route many paths.

### Production — real tunnel

Use Cloudflare Tunnel, Tailscale Funnel, or similar to expose the wake port.
Always set `WAKE_SECRET` and configure the webhook provider to send it as an
`x-wake-secret` header (or use their signing scheme + a small adapter).

## Declarative webhooks

Any coworker can declare inbound webhooks in
`coworkers/<name>/role/WEBHOOKS.json`. The runtime loads them on startup,
verifies signatures with a closed set of named verifiers, optionally filters
the payload, and wakes the loop (plus hints which sensor caches to
invalidate on the next tick). No custom code — new integrations are a JSON
edit.

Schema (top-level is an array). Linear example:

```json
[
  {
    "name": "linear",
    "path": "/webhook/linear",
    "auth": {
      "type": "hmac-sha256",
      "header": "linear-signature",
      "secretEnv": "LINEAR_WEBHOOK_SECRET"
    },
    "filter": { "jsonPath": "data.team.key", "allow": ["TEAM_A", "TEAM_B"] },
    "onEvent": {
      "wake": true,
      "invalidate": ["linear.new_issues"]
    }
  }
]
```

`filter` is optional — omit it to accept every signed request. When
present, the value at the JSON dot-path in the parsed body must equal
one of the strings in `allow`, otherwise the request is 202-acked
without waking.

`onEvent.invalidate` names sensor cache keys (from `SENSORS.json` or
native sensors) to force-refresh on the resulting tick.

`auth.type` is a closed set:

| type            | header (default)         | notes |
|-----------------|--------------------------|-------|
| `hmac-sha256`   | required — you name it   | HMAC-SHA256(body), hex-compare. |
| `github-sha256` | `x-hub-signature-256`    | Strips `sha256=` prefix before compare. |
| `slack-v0`      | `x-slack-signature`      | Slack v0 scheme; enforces `|now-ts| ≤ maxAgeSeconds` (default 300). |
| `none`          | —                        | Always accepts. Emits a startup warning. |

Return codes:
- `200` — signature valid, filter matched (if any), coworker woken.
- `202` — signature valid, filter did not match; ack, no wake.
- `401` — missing / bad signature.
- `404` — no webhook spec for that path.
- `503` — spec's `secretEnv` is not set in the process env.

If any webhook is configured the wake server binds to `0.0.0.0` so the
tunnel can reach it.

### Adding GitHub

```json
{
  "name": "github",
  "path": "/webhook/github",
  "auth": { "type": "github-sha256", "secretEnv": "GITHUB_WEBHOOK_SECRET" },
  "onEvent": { "wake": true, "invalidate": ["github.open_prs"] }
}
```

### Adding Slack

```json
{
  "name": "slack",
  "path": "/webhook/slack",
  "auth": { "type": "slack-v0", "secretEnv": "SLACK_SIGNING_SECRET", "maxAgeSeconds": 300 },
  "onEvent": { "wake": true }
}
```

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
