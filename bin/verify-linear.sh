#!/usr/bin/env bash
# Verify Linear setup landed for a coworker. Calls the `viewer` +
# `organization` GraphQL query with the stored LINEAR_API_KEY. Prints
# workspace + identity on success, fails loud on any auth error.
#
# Usage:  bin/verify-linear.sh <coworker>

set -euo pipefail
name="${1:?usage: verify-linear <coworker>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
envfile="$root/coworkers/$name/.env"
[ -f "$envfile" ] || { echo "No .env for $name at $envfile — run bin/setup-linear.sh $name first" >&2; exit 1; }

api_key=$(grep "^LINEAR_API_KEY=" "$envfile" | tail -n 1 | cut -d= -f2-)
[ -n "$api_key" ] || { echo "LINEAR_API_KEY not set in $envfile — run bin/setup-linear.sh $name" >&2; exit 1; }

echo "Verifying Linear access for coworker '$name'…"
resp=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $api_key" -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { name email } organization { name urlKey } teams { nodes { key name } } }"}')
if [ "$(echo "$resp" | jq -r '.data.viewer.email // empty')" = "" ]; then
  err=$(echo "$resp" | jq -r '.errors[0].message // "unknown"')
  echo "✗ Linear key rejected: $err" >&2
  exit 1
fi
org=$(echo "$resp" | jq -r '.data.organization.name')
url_key=$(echo "$resp" | jq -r '.data.organization.urlKey')
who=$(echo "$resp" | jq -r '.data.viewer.email')
teams=$(echo "$resp" | jq -r '.data.teams.nodes | map(.key) | join(", ")')
echo "✓ Linear auth OK."
echo "  workspace: $org (linear.app/$url_key)"
echo "  identity : $who"
echo "  teams    : $teams"

# Also verify the ignore list references real team keys (typo protection).
ignore=$(grep "^LINEAR_IGNORE_TEAMS=" "$envfile" | tail -n 1 | cut -d= -f2- || true)
if [ -n "$ignore" ]; then
  IFS=',' read -ra ignore_arr <<<"$ignore"
  IFS=',' read -ra teams_arr <<<"$teams"
  # Trim spaces
  ignore_arr=("${ignore_arr[@]// /}")
  teams_arr=("${teams_arr[@]// /}")
  for t in "${ignore_arr[@]}"; do
    found=0
    for x in "${teams_arr[@]}"; do [ "$t" = "$x" ] && found=1 && break; done
    if [ "$found" = "0" ]; then
      echo "  ⚠ LINEAR_IGNORE_TEAMS mentions '$t' which is not a team in this workspace"
    fi
  done
fi
