#!/usr/bin/env bash
# Restore a coworker's MEMORY.md from a saved version.
# Usage:
#   bin/memory-rollback.sh <coworker>              # list available versions
#   bin/memory-rollback.sh <coworker> <tag>        # restore that version
set -euo pipefail
name="${1:?usage: memory-rollback <coworker> [tag]}"
shift || true
root="$(cd "$(dirname "$0")/.." && pwd)"
mem="$root/coworkers/$name/state/memory.db"
mdpath="$root/coworkers/$name/state/memory/MEMORY.md"
[ -f "$mem" ] || { echo "no memory.db for $name" >&2; exit 1; }
if [ $# -eq 0 ]; then
  echo "available versions (newest first):"
  sqlite3 "$mem" "SELECT ts, tag, length(body) || ' chars' FROM memory_versions ORDER BY id DESC LIMIT 20" \
    | column -t -s '|'
  exit 0
fi
tag="$1"
body=$(sqlite3 "$mem" "SELECT body FROM memory_versions WHERE tag = '$tag' ORDER BY id DESC LIMIT 1")
[ -n "$body" ] || { echo "no version tagged $tag" >&2; exit 1; }
cp "$mdpath" "$mdpath.pre-rollback.$(date +%s)"
printf '%s\n' "$body" > "$mdpath"
echo "restored $mdpath from $tag (previous saved as .pre-rollback.*)"
