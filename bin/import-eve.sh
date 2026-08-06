#!/usr/bin/env bash
# Import a Vercel Eve agent into an ai-coworkers coworker.
# Usage:
#   bin/import-eve.sh <eve-agent-dir> <coworker-name>
#
# Eve `agent/` layout:
#   agent.ts          — model + runtime config (not ported; we use env)
#   instructions.md   — system prompt (required)
#   tools/            — typed function tools
#   skills/           — on-demand procedures
#   channels/         — HTTP / Slack / Discord integrations
#   schedules/        — cron jobs
#
# Mapping to ai-coworkers:
#   instructions.md  → role/ROLE.md
#   tools/           → src/adapters/eve.ts loads them at runtime;
#                      script does not copy — set EVE_AGENT_DIR=<src>
#                      and the adapter handles it.
#   schedules/       → role/RITUALS.md (concatenated with headings —
#                      each schedule file becomes a numbered section)
#   channels/        → hint printed; we map to ask.ts recipients, not a
#                      1:1 copy.
#
# Missing → stubbed:
#   RESPONSIBILITIES.md, AUTHORITY.md, BOUNDARIES.md, RELATIONSHIPS.md,
#   TOOLS.md, WORKSPACE.md, MEMORY.md.

set -euo pipefail

src="${1:?usage: import-eve <eve-agent-dir> <coworker-name>}"
name="${2:?usage: import-eve <eve-agent-dir> <coworker-name>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name: $name" >&2; exit 1; }
[ -d "$src" ] || { echo "no such Eve agent dir: $src" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/coworkers/$name"
[ -d "$dest" ] && { echo "coworker $name already exists at $dest — refusing to overwrite" >&2; exit 1; }

mkdir -p "$dest/role" "$dest/state/memory"

mapped=()
missing=()

if [ -f "$src/instructions.md" ]; then
  cp "$src/instructions.md" "$dest/role/ROLE.md"
  mapped+=("instructions.md → role/ROLE.md")
else
  missing+=("instructions.md (required in Eve — was this an Eve agent?)")
fi

# Concatenate schedules/*.md (or .ts described in front-matter) into RITUALS.md.
if [ -d "$src/schedules" ]; then
  {
    printf '# RITUALS\n\n'
    printf '## Tempo\n\n(Imported from Eve schedules — one section per file. '
    printf 'You may want to fold these into a single tempo policy.)\n\n'
    for f in "$src/schedules"/*; do
      [ -f "$f" ] || continue
      printf '### %s\n\n' "$(basename "$f")"
      cat "$f"
      printf '\n\n'
    done
  } > "$dest/role/RITUALS.md"
  mapped+=("schedules/ → role/RITUALS.md (concatenated)")
fi

# Empty stubs for docs Eve doesn't have.
for f in RESPONSIBILITIES.md AUTHORITY.md BOUNDARIES.md RELATIONSHIPS.md TOOLS.md WORKSPACE.md; do
  [ -f "$dest/role/$f" ] && continue
  printf '# %s\n\n(imported from Eve — please fill in)\n' "${f%.md}" > "$dest/role/$f"
done
printf '' > "$dest/state/memory/MEMORY.md"

[ -d "$src/tools" ]    && mapped+=("tools/ (left in place; set EVE_AGENT_DIR=$src to load via adapter)")
[ -d "$src/skills" ]   && mapped+=("skills/ (left in place; set SKILLS_DIR=$src/skills or ~/.hermes/skills)")
[ -d "$src/channels" ] && missing+=("channels/ (Eve HTTP/Slack/Discord — map manually to our ask tool recipients)")

echo
echo "Imported Eve agent into: $dest"
echo
echo "Ported directly:"
for m in "${mapped[@]}"; do echo "  ✓ $m"; done
echo
echo "Needs attention (stubs written or manual mapping required):"
for m in "${missing[@]}"; do echo "  ⚠ $m"; done
for f in RESPONSIBILITIES.md AUTHORITY.md BOUNDARIES.md RELATIONSHIPS.md TOOLS.md WORKSPACE.md; do
  echo "  ⚠ role/$f (stub)"
done
echo
echo "Run: node --experimental-strip-types --no-warnings src/index.ts $name"
