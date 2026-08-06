#!/usr/bin/env bash
# Interactive Slack setup for a coworker. Uses Hermes's `hermes slack
# manifest` to generate the Slack app spec, walks the operator through
# uploading it, then prompts for the tokens and writes them to
# coworkers/<name>/.env (gitignored).
#
# Usage:  bin/setup-slack.sh <coworker>

set -euo pipefail
name="${1:?usage: setup-slack <coworker>}"
[[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name" >&2; exit 1; }
command -v hermes >/dev/null || { echo "hermes CLI not found. Install: https://hermes-agent.nousresearch.com" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
envfile="$root/coworkers/$name/.env"
mkdir -p "$(dirname "$envfile")"

# 1. Generate the app manifest.
manifest_path="/tmp/slack-manifest-$name.json"
hermes slack manifest > "$manifest_path"
echo "Step 1/3 — Slack app manifest written to $manifest_path"
echo
echo "Step 2/3 — Create the Slack App"
echo "  1. Open https://api.slack.com/apps and click 'Create New App'"
echo "  2. Choose 'From an app manifest'"
echo "  3. Pick the workspace '$name' should live in"
echo "  4. Paste the contents of $manifest_path (JSON tab)"
echo "  5. Review scopes, click Create"
echo "  6. On the app's 'Install App' page, click 'Install to Workspace' → Allow"
echo "  7. Copy the 'Bot User OAuth Token' (starts with xoxb-)"
echo "  8. For Socket Mode: 'Basic Information' → 'App-Level Tokens' → generate one with"
echo "     scope 'connections:write'. Copy that too (starts with xapp-)."
echo
read -rp "Bot User OAuth Token (xoxb-...): " bot_token
[ -n "$bot_token" ] || { echo "empty bot token" >&2; exit 1; }
case "$bot_token" in
  xoxb-*) ;;
  *) echo "warning: token doesn't start with 'xoxb-' — proceeding anyway" >&2 ;;
esac
read -rp "App-Level Token (xapp-...) [optional, press enter to skip]: " app_token
read -rp "Watched channel IDs, comma-separated (e.g. C0123ABC,C0456DEF) [optional]: " channels

# 2. Write to .env (append or update). Never print the token back.
touch "$envfile"
# Remove existing SLACK_* lines to avoid duplicates.
tmp=$(mktemp)
grep -v "^SLACK_BOT_TOKEN=" "$envfile" | grep -v "^SLACK_APP_TOKEN=" | grep -v "^SLACK_WATCHED_CHANNELS=" > "$tmp" || true
mv "$tmp" "$envfile"
{
  echo "SLACK_BOT_TOKEN=$bot_token"
  [ -n "$app_token" ] && echo "SLACK_APP_TOKEN=$app_token"
  [ -n "$channels" ] && echo "SLACK_WATCHED_CHANNELS=$channels"
} >> "$envfile"

echo
echo "Step 3/3 — Verify (in a separate terminal, tail the coworker's stream.log after restart)"
echo "  Tokens written to $envfile (gitignored)"
echo "  On next tick, slack.mentions sensor will read; ask with to='slack:#channel' will post."
echo
echo "✓ Slack set up for '$name'."
