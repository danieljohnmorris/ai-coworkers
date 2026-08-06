#!/usr/bin/env bash
# Walk from a MEMORY.md citation back to the events that support it.
# Usage:
#   bin/why.sh <coworker> <id>[,<id>...]
#   bin/why.sh alex-triage 1234
#   bin/why.sh alex-triage 1234,1289,1301
#
# Pairs with the [ev:...] citations that reflect (AIC-70) writes into
# semantic MEMORY.md — a learning like "- Dogfood tickets are usually P2
# [ev:1234,1289,1301]" can be interrogated to see the actual events.

set -euo pipefail
name="${1:?usage: why <coworker> <id>[,<id>...]}"
ids="${2:?usage: why <coworker> <id>[,<id>...]}"

[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
[[ "$ids" =~ ^[0-9,]+$ ]] || { echo "ids must be comma-separated integers, got: $ids" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
db="$root/coworkers/$name/state/events.db"
[ -f "$db" ] || { echo "no events.db for $name at $db" >&2; exit 1; }

# Build a SQL IN clause safely (we've validated ids above).
in_clause="($ids)"
sqlite3 -header -column "$db" \
  "SELECT id, ts, kind, substr(payload, 1, 400) AS payload
   FROM events WHERE id IN $in_clause
   ORDER BY id ASC;"
