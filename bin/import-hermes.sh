#!/usr/bin/env bash
# Import a Hermes agent (Nous Research) into an ai-coworkers coworker.
# Usage:
#   bin/import-hermes.sh <hermes-agent-dir> <coworker-name>
#
# Hermes agents live in a workspace directory that typically contains:
#   SOUL.md      — persona / how the agent behaves
#   MEMORY.md    — long-term memory
#   USER.md      — who the agent is working with
#   skills/      — per-skill folders with SKILL.md (loaded by our
#                  src/adapters/hermes.ts adapter directly at runtime)
#
# Mapping to ai-coworkers coworker layout:
#   SOUL.md   → role/ROLE.md (persona)
#   USER.md   → role/RELATIONSHIPS.md (who they work with)
#   MEMORY.md → state/memory/MEMORY.md (semantic memory, subject to 2KB cap)
#   skills/   → left in place; point SKILLS_DIR at the hermes workspace
#               or copy in ~/.hermes/skills/ so the Hermes adapter picks
#               them up unmodified.
#
# What does NOT port and needs to be authored by hand:
#   role/RESPONSIBILITIES.md, AUTHORITY.md, BOUNDARIES.md, RITUALS.md,
#   TOOLS.md, WORKSPACE.md — Hermes has no equivalent structured docs.
#   The script writes minimal stubs and prints a checklist.

set -euo pipefail

src="${1:?usage: import-hermes <hermes-agent-dir> <coworker-name>}"
name="${2:?usage: import-hermes <hermes-agent-dir> <coworker-name>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
[ -d "$src" ] || { echo "no such Hermes agent dir: $src" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/coworkers/$name"
[ -d "$dest" ] && { echo "coworker $name already exists at $dest — refusing to overwrite" >&2; exit 1; }

mkdir -p "$dest/role" "$dest/state/memory"

mapped=()
missing=()

copy_if_exists() {
  local from="$1" to="$2" label="$3"
  if [ -f "$from" ]; then
    cp "$from" "$to"
    mapped+=("$label")
  else
    missing+=("$label")
  fi
}

copy_if_exists "$src/SOUL.md"   "$dest/role/ROLE.md"                 "SOUL.md → ROLE.md"
copy_if_exists "$src/USER.md"   "$dest/role/RELATIONSHIPS.md"        "USER.md → RELATIONSHIPS.md"
copy_if_exists "$src/MEMORY.md" "$dest/state/memory/MEMORY.md"       "MEMORY.md → state/memory/MEMORY.md"

# Stub the ai-coworkers docs Hermes doesn't have. The coworker won't run
# without at least ROLE.md; the rest are optional but recommended.
for f in RESPONSIBILITIES.md AUTHORITY.md BOUNDARIES.md RITUALS.md TOOLS.md WORKSPACE.md; do
  [ -f "$dest/role/$f" ] && continue
  printf '# %s\n\n(imported from Hermes — please fill in)\n' "${f%.md}" > "$dest/role/$f"
done

# Note the skills dir so the operator can point SKILLS_DIR at it.
if [ -d "$src/skills" ]; then
  mapped+=("skills/ (left in place; set SKILLS_DIR=$src/skills or copy into ~/.hermes/skills/)")
fi

echo
echo "Imported Hermes agent into: $dest"
echo
echo "Ported directly:"
for m in "${mapped[@]}"; do echo "  ✓ $m"; done
echo
echo "Not present in Hermes source (stubs written, please author):"
for m in "${missing[@]}"; do echo "  ⚠ $m"; done
for f in RESPONSIBILITIES.md AUTHORITY.md BOUNDARIES.md RITUALS.md TOOLS.md WORKSPACE.md; do
  echo "  ⚠ role/$f (stub)"
done
echo
echo "Run: node --experimental-strip-types --no-warnings src/index.ts $name"
