#!/usr/bin/env bash
# Answer a coworker's open questions.
# Usage:
#   bin/answer.sh <coworker>                  # open questions.md in $EDITOR
#   bin/answer.sh <coworker> "your answer"    # append answer to the most recent unanswered question
set -euo pipefail
name="${1:?usage: answer <coworker> [\"answer text\"]}"
shift || true
root="$(cd "$(dirname "$0")/.." && pwd)"
path="$root/coworkers/$name/state/questions.md"
[ -f "$path" ] || { echo "no questions from $name yet" >&2; exit 1; }
if [ $# -eq 0 ]; then
  ${EDITOR:-nano} "$path"
  exit 0
fi
answer="$*"
# Replace the LAST occurrence of the unanswered marker with the answer.
python3 - <<PY
import re, sys
with open("$path", "r") as f: text = f.read()
pat = r'(\*\*A:\*\*\s*_?\(?unanswered\)?_?)'
matches = list(re.finditer(pat, text))
if not matches:
    sys.exit("no unanswered questions")
last = matches[-1]
new = text[:last.start()] + "**A:** " + $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$answer") + text[last.end():]
with open("$path", "w") as f: f.write(new)
print("answered")
PY
