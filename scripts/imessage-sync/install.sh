#!/usr/bin/env bash
# Installs the Bedrock iMessage sync on macOS.
# - Writes config to ~/.bedrock-imessage/config.json
# - Installs a launchd agent that runs sync.mjs every 120 seconds.
# Safe to re-run; idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.bedrock-imessage"
CONFIG_FILE="$CONFIG_DIR/config.json"
LOG_FILE="$CONFIG_DIR/sync.log"
ERR_FILE="$CONFIG_DIR/sync.err"
PLIST_NAME="com.bedrock.imessage-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
CHAT_DB="$HOME/Library/Messages/chat.db"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

mkdir -p "$CONFIG_DIR"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Could not find 'node'. Install Node 20+ and re-run, or set NODE_BIN=/path/to/node."
  exit 1
fi

if [[ ! -f "$CHAT_DB" ]]; then
  echo "chat.db not found at $CHAT_DB. Is iMessage set up on this Mac?"
  exit 1
fi

echo "Installing dependencies (better-sqlite3)..."
(cd "$SCRIPT_DIR" && npm install --no-fund --no-audit --silent)

prompt() {
  local label="$1"; local default_val="${2:-}"; local var
  if [[ -n "$default_val" ]]; then
    read -r -p "$label [$default_val]: " var || true
    echo "${var:-$default_val}"
  else
    read -r -p "$label: " var || true
    echo "$var"
  fi
}

prior_json() {
  local key="$1"
  [[ -f "$CONFIG_FILE" ]] || { echo ""; return; }
  "$NODE_BIN" -e "try { const c = require('$CONFIG_FILE'); process.stdout.write(String(c['$key'] ?? '')); } catch { process.stdout.write(''); }"
}

API_BASE=$(prompt "Bedrock base URL" "$(prior_json api_base)")
WORKSPACE_ID=$(prompt "Workspace ID (uuid)" "$(prior_json workspace_id)")
API_KEY=$(prompt "Workspace API key (from Bedrock settings)" "$(prior_json api_key)")

echo ""
echo "Looking up your most recent group chats from chat.db..."
echo "(If this fails with 'authorization denied', grant Full Disk Access to Terminal and retry.)"
echo ""

sqlite3 -readonly "$CHAT_DB" <<'SQL' || { echo "sqlite3 failed — did you grant Full Disk Access?"; exit 1; }
.mode column
.headers on
.width 42 24 60
SELECT c.guid AS chat_guid,
       COALESCE(c.display_name, '(no name)') AS display_name,
       group_concat(DISTINCT h.id) AS participants
FROM chat c
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h ON h.ROWID = chj.handle_id
JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
JOIN message m ON m.ROWID = cmj.message_id
GROUP BY c.guid
HAVING COUNT(DISTINCT h.id) >= 2
ORDER BY MAX(m.date) DESC
LIMIT 20;
SQL

echo ""
CHAT_GUID=$(prompt "chat.guid to sync (copy from list above)" "$(prior_json chat_guid)")

CURRENT_HANDLES=$(prior_json coordinator_bedrock_handles)
BEDROCK_HANDLES=$(prompt "Your + cofounder's iMessage handles, comma-separated (labelled 'Bedrock')" "$CURRENT_HANDLES")
COORD_LABEL=$(prompt "Label for the other person (Jose / coordinator name)" "$(prior_json coordinator_label || echo Jose)")

"$NODE_BIN" -e "
const fs = require('fs');
const cfg = {
  api_base: '$API_BASE',
  workspace_id: '$WORKSPACE_ID',
  api_key: '$API_KEY',
  chat_guid: '$CHAT_GUID',
  coordinator_bedrock_handles: '$BEDROCK_HANDLES'.split(',').map(s => s.trim()).filter(Boolean),
  coordinator_label: '$COORD_LABEL'
};
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
fs.chmodSync('$CONFIG_FILE', 0o600);
console.log('Wrote', '$CONFIG_FILE');
"

# Push config to the Bedrock server so the ingest endpoint labels messages correctly.
echo "Syncing config to Bedrock..."
CONFIG_PUSH_BODY="$("$NODE_BIN" -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
process.stdout.write(JSON.stringify({
  chat_guid: cfg.chat_guid,
  bedrock_handles: cfg.coordinator_bedrock_handles,
  coordinator_label: cfg.coordinator_label
}));
")"
CONFIG_PUSH_STATUS=$(curl -s -o /tmp/bedrock-config-resp -w "%{http_code}" \
  -X POST "$API_BASE/api/imessage/config" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$CONFIG_PUSH_BODY" || echo "000")
if [[ "$CONFIG_PUSH_STATUS" == "200" ]]; then
  echo "  Server config updated."
else
  echo "  WARNING: config push returned HTTP $CONFIG_PUSH_STATUS. Response:"
  cat /tmp/bedrock-config-resp 2>/dev/null || true
  echo ""
  echo "  You can set the handles manually at $API_BASE/<workspace>/settings/coordinator"
fi

# launchd plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SCRIPT_DIR/sync.mjs</string>
  </array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$ERR_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo ""
echo "Installed launchd agent: $PLIST_NAME"
echo "  Plist: $PLIST_PATH"
echo "  Logs : $LOG_FILE"
echo ""
echo "If sync.err shows 'authorization denied' errors, grant Full Disk Access to:"
echo "  $NODE_BIN"
echo "in System Settings → Privacy & Security → Full Disk Access."
echo ""
echo "Run once manually to verify:"
echo "  $NODE_BIN $SCRIPT_DIR/sync.mjs --dry-run"
