#!/usr/bin/env bash
# Leave a 👍 or 👎 reaction for a coworker. Appears in its next tick's
# perception once, then marks as read (AIC-71). Cheap human-in-the-loop
# reinforcement signal without a full RLHF setup.
#
# Usage:
#   bin/react.sh <coworker> <👍|👎|+1|-1|up|down> ["note"]
#
# Examples:
#   bin/react.sh alex-triage +1 "the CS-4 handoff was clean"
#   bin/react.sh alex-triage -1 "stop reopening ILO-509 — it's fine"

set -euo pipefail
name="${1:?usage: react <coworker> <👍|👎|+1|-1|up|down> [note]}"
verdict_in="${2:?usage: react <coworker> <👍|👎|+1|-1|up|down> [note]}"
shift 2 || true
note="${*:-}"

[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }

case "$verdict_in" in
  "👍"|"+1"|"up"|"good") verdict="👍" ;;
  "👎"|"-1"|"down"|"bad") verdict="👎" ;;
  *) echo "verdict must be one of: 👍 👎 +1 -1 up down (got: $verdict_in)" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
log="$root/coworkers/$name/state/reactions.log"
mkdir -p "$(dirname "$log")"

ts="$(date -Iseconds)"
if [ -n "$note" ]; then
  printf '{"ts":%s,"verdict":%s,"note":%s}\n' \
    "$(jq -Rn --arg v "$ts" '$v')" \
    "$(jq -Rn --arg v "$verdict" '$v')" \
    "$(jq -Rn --arg v "$note" '$v')" >> "$log"
else
  printf '{"ts":%s,"verdict":%s}\n' \
    "$(jq -Rn --arg v "$ts" '$v')" \
    "$(jq -Rn --arg v "$verdict" '$v')" >> "$log"
fi

echo "$verdict recorded for $name${note:+ — $note}"
