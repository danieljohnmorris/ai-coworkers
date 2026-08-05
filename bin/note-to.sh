#!/usr/bin/env bash
# Leave a note in a coworker's inbox. Appears in their next tick's perception.
# Usage: bin/note-to.sh <coworker> "message"
set -euo pipefail
name="${1:?usage: note-to <coworker> \"message\"}"
shift
msg="$*"
[ -z "$msg" ] && { echo "usage: note-to <coworker> \"message\"" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
inbox="$root/coworkers/$name/state/inbox.md"
mkdir -p "$(dirname "$inbox")"
printf '## %s\n%s\n\n' "$(date -Iseconds)" "$msg" >> "$inbox"
echo "written to $inbox"
