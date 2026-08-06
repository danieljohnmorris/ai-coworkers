#!/usr/bin/env bash
# Import an OpenClaw workspace into an ai-coworkers coworker.
# Usage:
#   bin/import-openclaw.sh <openclaw-workspace-dir> <coworker-name>
#
# OpenClaw workspace convention:
#   AGENTS.md    — core operating instructions (multi-agent selector too)
#   SOUL.md      — persona / voice
#   TOOLS.md     — operational notes about available tools
#   MEMORY.md    — long-term memory
#   skills/      — skill folders (compatible with our Hermes adapter —
#                  same SKILL.md front-matter convention)
#
# Mapping to ai-coworkers:
#   AGENTS.md → role/RESPONSIBILITIES.md (what the agent owns)
#   SOUL.md   → role/ROLE.md (persona)
#   TOOLS.md  → role/TOOLS.md (may need trimming to tools we register)
#   MEMORY.md → state/memory/MEMORY.md
#   skills/   → left in place; set SKILLS_DIR
#
# Missing → stubbed for the operator to author:
#   AUTHORITY.md, BOUNDARIES.md, RITUALS.md, RELATIONSHIPS.md, WORKSPACE.md

set -euo pipefail

src="${1:?usage: import-openclaw <openclaw-workspace-dir> <coworker-name>}"
name="${2:?usage: import-openclaw <openclaw-workspace-dir> <coworker-name>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
[ -d "$src" ] || { echo "no such OpenClaw workspace: $src" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/coworkers/$name"
[ -d "$dest" ] && { echo "coworker $name already exists at $dest — refusing to overwrite" >&2; exit 1; }

mkdir -p "$dest/role" "$dest/state/memory"

mapped=()
missing=()
copy_if_exists() {
  local from="$1" to="$2" label="$3"
  if [ -f "$from" ]; then cp "$from" "$to"; mapped+=("$label"); else missing+=("$label"); fi
}

copy_if_exists "$src/SOUL.md"   "$dest/role/ROLE.md"                 "SOUL.md → ROLE.md"
copy_if_exists "$src/AGENTS.md" "$dest/role/RESPONSIBILITIES.md"     "AGENTS.md → RESPONSIBILITIES.md"
copy_if_exists "$src/TOOLS.md"  "$dest/role/TOOLS.md"                "TOOLS.md → TOOLS.md"
copy_if_exists "$src/MEMORY.md" "$dest/state/memory/MEMORY.md"       "MEMORY.md → state/memory/MEMORY.md"

for f in AUTHORITY.md BOUNDARIES.md RITUALS.md RELATIONSHIPS.md WORKSPACE.md; do
  [ -f "$dest/role/$f" ] && continue
  printf '# %s\n\n(imported from OpenClaw — please fill in)\n' "${f%.md}" > "$dest/role/$f"
done

if [ -d "$src/skills" ]; then
  mapped+=("skills/ (left in place; set SKILLS_DIR=$src/skills)")
fi

echo
echo "Imported OpenClaw workspace into: $dest"
echo
echo "Ported directly:"
for m in "${mapped[@]}"; do echo "  ✓ $m"; done
echo
echo "Not present in OpenClaw source (stubs written, please author):"
for m in "${missing[@]}"; do echo "  ⚠ $m"; done
for f in AUTHORITY.md BOUNDARIES.md RITUALS.md RELATIONSHIPS.md WORKSPACE.md; do
  echo "  ⚠ role/$f (stub)"
done
echo
echo "Run: node --experimental-strip-types --no-warnings src/index.ts $name"
