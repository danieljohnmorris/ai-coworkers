# Running a coworker as a systemd user service

The template at `templates/systemd/coworker@.service` is a parameterized unit:
one file, many coworkers, each named after its directory under `coworkers/`.

## Install (one-time)

```
mkdir -p ~/.config/systemd/user
cp templates/systemd/coworker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

## Environment file

The unit reads env vars from `~/ai-coworkers/.env` (already gitignored).
Ensure it exports at minimum:

```
OLLAMA_API_KEY=...
COWORKER_MODEL=gemma4:cloud
TICK_INTERVAL_MS=300000   # 5min
```

Linear is no longer a static API key — it's an OAuth-based MCP server.
Add it to `MCP_SERVERS` (see below) and do the browser consent once.

Add `MCP_SERVERS=...` and `SKILLS_DIR=...` if you're using adapters.

## Enable and start a coworker

```
systemctl --user enable  coworker@alex-triage.service
systemctl --user start   coworker@alex-triage.service
systemctl --user status  coworker@alex-triage.service
```

## Follow the logs

```
journalctl --user -u coworker@alex-triage.service -f
```

For the full structured event log (SQLite):

```
sqlite3 ~/ai-coworkers/coworkers/alex-triage/state/events.db \
  "SELECT ts, kind, substr(payload,1,150) FROM events ORDER BY id DESC LIMIT 20"
```

## Restart-on-failure semantics

The unit sets `Restart=on-failure` with `RestartSec=10s`. If the process exits
non-zero, systemd will restart it after 10 seconds. Crash log lives at
`coworkers/<name>/state/crash.log`; the events db keeps a per-tick timeline.

## Run multiple coworkers on the same machine

Each becomes its own unit instance:

```
systemctl --user enable --now coworker@alex-triage.service
systemctl --user enable --now coworker@sam-pr-reviewer.service
systemctl --user enable --now coworker@priya-pm.service
```

They share nothing except the runtime code and `.env` — separate SQLite dbs,
separate memory, separate boundaries.

## Enable lingering (start on boot without login)

```
loginctl enable-linger $USER
```

## Stop and disable

```
systemctl --user stop     coworker@alex-triage.service
systemctl --user disable  coworker@alex-triage.service
```
