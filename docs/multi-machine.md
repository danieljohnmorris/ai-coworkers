# Multi-machine deployment

The default assumption in this codebase is **one coworker per process,
one process per Linux user**. That covers 90% of real deployments (your
laptop, a Hetzner box, a Raspberry Pi at home). This page covers the
harder shapes: multiple coworkers on one machine, one fleet across
several machines, and the operational patterns that hold up.

## Baseline: one machine, N coworkers

Simplest path. Each coworker gets its own `coworkers/<name>/` directory,
its own systemd unit (see [systemd.md](systemd.md)), and its own port
for `/wake` and `/metrics` if enabled.

```
alex-triage.service    → coworkers/alex-triage/    → WAKE_PORT=7778
watchtower.service     → coworkers/watchtower/     → WAKE_PORT=7779
scribe.service         → coworkers/scribe/         → WAKE_PORT=7780
```

Constraints to remember:
- Each coworker has its own `state/events.db`. Cross-coworker search
  (see AIC-53) is not shipped yet — for now, `sqlite3` across all three
  files is the workaround.
- `SKILLS_DIR` and `MCP_SERVERS` can be shared or per-coworker; shared
  is simpler unless you want different permission scopes per role.
- If two coworkers should never see each other's tokens, put the
  sensitive one under a different Linux user with its own `.env`.

## Fleet: multiple machines, one operator

Two axes of choice: **shared state or per-machine state**, and
**shared config or per-machine config**.

### Recommended default — per-machine state, shared config via git

Each machine runs its own coworkers with local `state/`. Role docs +
skills live in a git repo (this one, or a fork) that every machine
pulls from.

- Deploy = `git pull && systemctl --user restart <coworker>@*.service`.
- Role changes propagate on next pull; the hot-reload watcher
  (AIC-58) picks them up without a restart if the machine already
  has the file open.
- State stays local — no cross-machine race conditions on events.db.
- Each machine's metrics endpoint is its own scrape target for
  Prometheus.

### Only when you have a real reason — shared state via NFS / SMB

You can put `coworkers/<name>/state/` on shared storage and run the
coworker from multiple machines. This is **not recommended** — SQLite
concurrency across NFS is a known footgun, and the tick loop assumes
one writer per events.db (see [ADR 0004](adr/0004-events-db-single-file.md)).

If you need active/passive failover, prefer:
- **Active/standby with a lock file** — the primary machine holds
  `state/pid.lock`; the standby polls, takes over on staleness. Requires
  a coordination story (systemd, consul, k8s) but keeps SQLite happy.
- **Ephemeral coworkers per machine** — same role, per-machine state,
  duplicate work if any. Fine for read-only sensors, wrong for anything
  that comments/writes.

## Networking

- **Outbound** — every machine needs the same egress reachability
  (Linear API, Slack API, GitHub API, your LLM host). No NAT tricks
  needed.
- **Inbound (webhooks)** — pick one machine as the webhook target and
  either:
  1. **Public tunnel from just that box** — Cloudflare Tunnel,
     Tailscale Funnel, ngrok. The webhook only wakes that one machine's
     coworkers. If the coworker's job is on a different box, sensors
     poll it on the next tick.
  2. **Load-balancer + shared `WAKE_SECRET`** — Caddy in front of two
     wake ports; either machine wakes. Adds a hop but avoids single-
     point failure. Overkill for most.
- **Between coworkers on different machines** — no direct mechanism.
  Use whatever your team already uses (Slack, Linear comments) via the
  `ask` tool. The coworker on machine A files a Linear ticket assigned
  to machine B's coworker; machine B's next tick sees it.

## Secrets

Do NOT rely on per-machine `.env` alone if the same coworker runs on
multiple machines — you'll drift. Two viable patterns:

1. **Central secret store** — `sops`-encrypted `.env.enc` in the
   config repo, decrypted at systemd start via a `EnvironmentFile=`
   pointing at a decryption wrapper. Every machine has the same
   secrets.
2. **1Password / Vault CLI** — coworker starts under a wrapper that
   pulls secrets fresh:
   `op run --env-file=.env.template -- node …`.

Never commit unencrypted `.env` to the config repo. `sops` +
`age`/`gpg` is the cheap path if you're not already on Vault.

## Backup and disaster recovery

Per-coworker directory is the whole state — back up `coworkers/<name>/`
in full. Restore = drop it back, start the coworker. The tick loop
picks up from the last `tick.end` in events.db.

- **Snapshot cadence** — daily rsync to a second host is enough for
  most cases. State drift is per-tick, so a 24h RPO loses at most one
  day of memory + audit trail.
- **What NOT to restore** — `state/hygiene.db` (rebuilt at startup),
  `state/scratch/` (transient), `stream.log` (append-only, will grow
  again). MEMORY.md matters; events.db matters; role/*.md matters.

## When to introduce a real orchestrator

Signals it's time:
- Three or more machines each running the same coworker.
- You need blue/green deploys of a role-doc change.
- You need per-tenant coworker instantiation.

At that point look at k8s or nomad — a coworker is basically a stateful
sidecarless service. Not shipping opinions here yet; the codebase
doesn't force any particular choice.

## Related

- [systemd deployment](systemd.md) — the boring, correct, single-machine setup.
- [Webhooks + external wakes](webhooks.md) — how `/wake` interacts with tunnels.
- [ADR 0004](adr/0004-events-db-single-file.md) — why we do not split
  events.db across writers.
- [Dedicated Linear identity](dedicated-linear-user.md) — per-coworker
  service accounts, which matter more once multiple coworkers post to
  the same tracker.
