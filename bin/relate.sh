#!/usr/bin/env bash
# AIC-55 — append a RELATIONSHIP edge to a coworker's entity store.
# Usage:
#   bin/relate.sh <coworker> <fromKind>:<fromKey> <type> <toKind>:<toKey> ["note"]
#
# Example:
#   bin/relate.sh alex-triage person:dan works_on project:ILO
#   bin/relate.sh alex-triage person:dan reviews project:CS "just PRs, not full triage"
#
# Edges show up in the coworker's next tick perception under a
# 'relationships' subheading beneath each detected entity card.

set -euo pipefail
name="${1:?usage: relate <coworker> <fromKind>:<fromKey> <type> <toKind>:<toKey> [note]}"
from="${2:?from ref}"
type="${3:?relationship type}"
to="${4:?to ref}"
note="${5:-}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$name" ROOT="$root" FROM="$from" TYPE="$type" TO="$to" NOTE="$note" \
node --experimental-strip-types --no-warnings -e '
  const [ROOT, NAME, FROM, TYPE, TO, NOTE] = ["ROOT","NAME","FROM","TYPE","TO","NOTE"].map(k => process.env[k]);
  const path = await import("node:path");
  const { openEntities } = await import(ROOT + "/src/runtime/entities.ts");
  const store = openEntities(path.join(ROOT, "coworkers", NAME, "state", "entities"));
  const split = (s) => { const [k, ...rest] = s.split(":"); return { kind: k, key: rest.join(":") }; };
  const r = store.relate({ from: split(FROM), to: split(TO), type: TYPE, note: NOTE || undefined });
  if (!r.accepted) { console.error("rejected:", r.reason); process.exit(1); }
  console.log(`${FROM} —[${TYPE}]→ ${TO}${NOTE ? " (" + NOTE + ")" : ""}`);
'
