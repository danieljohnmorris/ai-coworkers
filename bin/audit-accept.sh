#!/usr/bin/env bash
# Accept the current role docs as the new audit baseline (AIC-78).
# Use after reviewing findings and confirming the role-doc changes are
# intentional. Copies current role/*.md into state/audit/snapshots/.
#
# Usage:
#   bin/audit-accept.sh <coworker>
#   bin/audit-accept.sh <coworker> BOUNDARIES   # accept only one doc

set -euo pipefail
name="${1:?usage: audit-accept <coworker> [DOC]}"
only="${2:-}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
role="$root/coworkers/$name/role"
snap="$root/coworkers/$name/state/audit/snapshots"
[ -d "$role" ] || { echo "no coworker at $role" >&2; exit 1; }
mkdir -p "$snap"

count=0
for f in "$role"/*.md; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  if [ -n "$only" ] && [ "$base" != "$only.md" ] && [ "$base" != "$only" ]; then continue; fi
  cp "$f" "$snap/$base"
  echo "accepted: $base"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "no docs matched" >&2; exit 1; }
