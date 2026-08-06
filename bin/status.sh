#!/usr/bin/env bash
# One-block status readout for a running coworker.
# Usage: bin/status.sh <coworker>
# Reports: pid/etime, mode (LIVE/DRY-RUN), wake mode + port listen state,
# ticks today, last action, sensor errors in last hour. No prompts.
# Deps: pgrep, ps, ss, sqlite3.

set -euo pipefail
name="${1:?usage: status <coworker>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/coworkers/$name/state"
[ -d "$state" ] || { echo "no such coworker: $name (missing $state)" >&2; exit 1; }
stream="$state/stream.log"
db="$state/events.db"

# process — match "src/index.ts <name>" exactly to avoid other coworkers.
pid="$(pgrep -f "src/index.ts $name(\$| )" | head -n1 || true)"
if [ -n "$pid" ]; then
  etime="$(ps -o etime= -p "$pid" | tr -d ' ' || echo "?")"
  proc_line="pid $pid, up $etime"
else
  proc_line="not running"
fi

# mode — most recent live= from stream.log
mode="unknown"
if [ -f "$stream" ]; then
  last_live="$(grep -oE 'live=(true|false)' "$stream" | tail -n1 || true)"
  case "$last_live" in
    live=true)  mode="LIVE" ;;
    live=false) mode="DRY-RUN" ;;
  esac
fi

# wake_mode + port
wake_mode="?"
wake_port=""
if [ -f "$stream" ]; then
  wm="$(grep -oE 'wake_mode=[a-z]+' "$stream" | tail -n1 || true)"
  wake_mode="${wm#wake_mode=}"
  # "wake endpoint: http://127.0.0.1:<port>/wake"
  wp="$(grep -oE 'wake endpoint: http://[0-9.]+:[0-9]+' "$stream" | tail -n1 | grep -oE '[0-9]+$' || true)"
  wake_port="$wp"
fi
port_state=""
if [ -n "$wake_port" ]; then
  if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${wake_port}\$"; then
    port_state="port: $wake_port (listening)"
  else
    port_state="port: $wake_port (NOT listening)"
  fi
else
  port_state="port: (none)"
fi

# tick + last action + sensor errors (guard against missing db)
ticks_today="?"
last_action="(none)"
sensor_errs="?"
if [ -f "$db" ]; then
  ticks_today="$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='tick.start' AND ts > date('now','start of day')" 2>/dev/null || echo "?")"
  last_action="$(sqlite3 -separator '  ' "$db" "SELECT ts, substr(payload,1,120) FROM events WHERE kind='action' ORDER BY id DESC LIMIT 1" 2>/dev/null || true)"
  [ -z "$last_action" ] && last_action="(none)"
  sensor_errs="$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='sensor.error' AND ts > datetime('now','-1 hour')" 2>/dev/null || echo "?")"
fi

echo "$name — $mode ($proc_line)"
echo "  mode: $wake_mode   $port_state"
echo "  ticks today: $ticks_today"
echo "  last action: $last_action"
echo "  sensor errors (1h): $sensor_errs"
