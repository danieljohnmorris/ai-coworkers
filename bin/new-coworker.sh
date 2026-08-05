#!/usr/bin/env bash
# Scaffold a new coworker. Usage: bin/new-coworker.sh <name>
set -euo pipefail
name="${1:?usage: new-coworker <name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/coworkers/$name/role"
if [ -e "$root/coworkers/$name" ]; then
  echo "already exists: $root/coworkers/$name" >&2
  exit 1
fi
mkdir -p "$dir" "$root/coworkers/$name/state"

cat > "$dir/ROLE.md" <<EOF
You are **${name}**, [one-paragraph identity: who you are, working style].
EOF

cat > "$dir/RESPONSIBILITIES.md" <<'EOF'
- [Ownership 1 — specific and measurable]
- [Ownership 2]
- Never spam. Most ticks should be no-ops.
EOF

cat > "$dir/AUTHORITY.md" <<'EOF'
## Decide alone
- [Thing you can do without asking]

## Escalate to Dan
- [Thing that needs human sign-off]
EOF

cat > "$dir/BOUNDARIES.md" <<'EOF'
## Must not touch
- [Off-limits target 1]

## Resource limits
- Max concurrent worktrees: 3
- Max worktree age: 24 h
- Max disk usage: 2048 MB
- Kill subprocesses idle > 30 min
EOF

cat > "$dir/RITUALS.md" <<'EOF'
- Every tick: [what happens]
- Daily 09:00: [what happens]
- Sunday 03:00: memory compaction.
EOF

cat > "$dir/RELATIONSHIPS.md" <<'EOF'
- **Dan** (human): manager, escalation target.
EOF

cat > "$dir/TOOLS.md" <<'EOF'
- clock
- memory
EOF

echo "scaffolded: $root/coworkers/$name"
echo "run:  node --experimental-strip-types --no-warnings src/index.ts $name"
