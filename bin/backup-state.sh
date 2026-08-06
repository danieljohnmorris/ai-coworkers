#!/usr/bin/env bash
# Snapshot coworker state/ to state.bak/ via rsync --delete.
# Usage: bin/backup-state.sh [<coworker>]
#   no arg  -> back up every coworker under coworkers/
#   <name>  -> back up just that one
# Never deletes source state/. Errors on any I/O failure.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cw_root="$root/coworkers"
[ -d "$cw_root" ] || { echo "no coworkers directory at $cw_root" >&2; exit 1; }

backup_one() {
  local name="$1"
  local src="$cw_root/$name/state"
  local dst="$cw_root/$name/state.bak"
  if [ ! -d "$src" ]; then
    echo "skip $name: no state/ directory" >&2
    return 0
  fi
  mkdir -p "$dst"
  # --delete makes this a snapshot; source is never touched.
  rsync -a --delete "$src/" "$dst/"
  local files bytes
  files="$(find "$dst" -type f | wc -l | tr -d ' ')"
  bytes="$(du -sb "$dst" | awk '{print $1}')"
  echo "backed up $name: $bytes bytes across $files files"
}

if [ "${1:-}" != "" ]; then
  name="$1"
  [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
  [ -d "$cw_root/$name" ] || { echo "no such coworker: $name" >&2; exit 1; }
  backup_one "$name"
else
  found=0
  for dir in "$cw_root"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    # Skip the state.bak dir itself if somehow at top level (defensive).
    [ "$name" = "state.bak" ] && continue
    backup_one "$name"
    found=1
  done
  [ "$found" -eq 1 ] || echo "no coworkers found under $cw_root" >&2
fi
