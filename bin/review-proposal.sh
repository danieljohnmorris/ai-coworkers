#!/usr/bin/env bash
# Review a coworker's role-change proposals.
# Usage:
#   bin/review-proposal.sh <coworker>                          # list proposals
#   bin/review-proposal.sh <coworker> show <id>                # print one proposal
#   bin/review-proposal.sh <coworker> accept <id> ["note"]     # apply to role/<DOC>.md
#   bin/review-proposal.sh <coworker> reject <id> ["note"]
set -euo pipefail
name="${1:?usage: review-proposal <coworker> [show|accept|reject <id> [note]]}"
cmd="${2:-list}"
id="${3:-}"
note="${4:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
pdir="$root/coworkers/$name/state/proposals"

case "$cmd" in
  list)
    node --experimental-strip-types --no-warnings -e "
      import('$root/src/runtime/role-proposals.ts').then(({ listProposals }) => {
        const ps = listProposals('$pdir');
        if (!ps.length) { console.log('no proposals from $name'); return; }
        for (const p of ps) console.log(\`\${p.status.padEnd(8)} \${p.id}  [\${p.doc}]  \${p.rationale.slice(0, 80)}\`);
      });"
    ;;
  show)
    [ -n "$id" ] || { echo "usage: review-proposal $name show <id>" >&2; exit 1; }
    cat "$pdir/$id.md"
    ;;
  accept|reject)
    [ -n "$id" ] || { echo "usage: review-proposal $name $cmd <id> [note]" >&2; exit 1; }
    REVIEW_NOTE="$note" node --experimental-strip-types --no-warnings -e "
      import('$root/src/runtime/role-proposals.ts').then(({ resolveProposal }) => {
        const r = resolveProposal({
          proposalsDir: '$pdir',
          roleDir: '$root/coworkers/$name/role',
          id: '$id',
          verdict: '$cmd',
          note: process.env.REVIEW_NOTE || undefined,
        });
        console.log(r.reason);
        if (!r.ok) process.exit(1);
      });"
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 1
    ;;
esac
