#!/usr/bin/env bash
# Scaffold a new coworker under coworkers/<name>/ from an example template.
# Usage:
#   bin/new-coworker.sh <name> [example]
# Default example: generic-triage
set -euo pipefail
name="${1:?usage: new-coworker <name> [example]}"
example="${2:-generic-triage}"
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/examples/$example"
dst="$root/coworkers/$name"

if [ ! -d "$src" ]; then
  echo "unknown example: $example" >&2
  echo "available:" >&2
  ls "$root/examples" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi
if [ -e "$dst" ]; then
  echo "already exists: $dst" >&2
  exit 1
fi

cp -r "$src" "$dst"
mkdir -p "$dst/state"

echo "scaffolded: $dst"
echo
echo "next steps:"
echo "  1. edit $dst/role/WORKSPACE.md (teams, priority conventions, style)"
echo "  2. review $dst/role/AUTHORITY.md and BOUNDARIES.md"
echo "  3. run: node --experimental-strip-types --no-warnings src/index.ts $name"
