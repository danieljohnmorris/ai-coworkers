#!/usr/bin/env bash
# Interactive Linear setup for a coworker. Prompts for a personal API
# key (or better: a service-account key — see docs/dedicated-linear-user.md),
# offers to configure watched/ignored teams and the optional webhook
# secret, and writes everything to coworkers/<name>/.env (gitignored).
#
# Usage:  bin/setup-linear.sh <coworker>
#
# Unlike Gmail (OAuth) and Slack (app manifest), Linear uses static
# personal API keys — so there's no browser flow, just a paste-and-go.
# We still make it a script so operators don't have to remember the
# LINEAR_* env-var names and so we can nudge them toward a dedicated
# service account (via docs/dedicated-linear-user.md).

set -euo pipefail
name="${1:?usage: setup-linear <coworker>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
envfile="$root/coworkers/$name/.env"
mkdir -p "$(dirname "$envfile")"

echo "Setting up Linear for coworker '$name'."
echo
echo "Best practice: create a DEDICATED Linear identity for the coworker,"
echo "not your personal account. See docs/dedicated-linear-user.md for the"
echo "seat-vs-OAuth trade-off. Comments will appear under whoever owns the key."
echo
echo "Get a personal API key at: https://linear.app/settings/api"
echo
read -rp "Linear API key (starts with lin_api_): " api_key
[ -n "$api_key" ] || { echo "empty key" >&2; exit 1; }
case "$api_key" in
  lin_api_*) ;;
  *) echo "warning: key doesn't start with 'lin_api_' — proceeding anyway" >&2 ;;
esac

# Optional: quick auth check before we write anything.
echo
echo "Verifying key against Linear API…"
resp=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $api_key" -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { name email } organization { name urlKey } teams { nodes { key name } } }"}')
if [ "$(echo "$resp" | jq -r '.data.viewer.email // empty')" = "" ]; then
  echo "✗ Key rejected. Response: $(echo "$resp" | head -c 300)" >&2
  exit 1
fi
org=$(echo "$resp" | jq -r '.data.organization.name')
who=$(echo "$resp" | jq -r '.data.viewer.email')
teams=$(echo "$resp" | jq -r '.data.teams.nodes | map(.key) | join(", ")')
echo "✓ Key valid."
echo "  workspace: $org"
echo "  identity : $who"
echo "  teams    : $teams"
echo

read -rp "Comma-separated team keys the coworker should IGNORE [optional]: " ignore_teams
read -rp "LINEAR_WEBHOOK_SECRET (only if this coworker will receive Linear webhooks via /wake) [optional]: " webhook_secret
read -rp "LINEAR_WATCHED_TEAMS for the webhook filter [optional, defaults to accept all]: " watched_teams

# Remove existing LINEAR_* lines to avoid duplicates, then append.
touch "$envfile"
tmp=$(mktemp)
grep -v "^LINEAR_API_KEY=" "$envfile" \
  | grep -v "^LINEAR_IGNORE_TEAMS=" \
  | grep -v "^LINEAR_WEBHOOK_SECRET=" \
  | grep -v "^LINEAR_WATCHED_TEAMS=" > "$tmp" || true
mv "$tmp" "$envfile"
{
  echo "LINEAR_API_KEY=$api_key"
  [ -n "$ignore_teams" ]   && echo "LINEAR_IGNORE_TEAMS=$ignore_teams"
  [ -n "$webhook_secret" ] && echo "LINEAR_WEBHOOK_SECRET=$webhook_secret"
  [ -n "$watched_teams" ]  && echo "LINEAR_WATCHED_TEAMS=$watched_teams"
} >> "$envfile"

echo
echo "✓ Linear set up for '$name'. Tokens written to $envfile (gitignored)."
echo "  Verify anytime with: bin/verify-linear.sh $name"
