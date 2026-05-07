# Bedrock iMessage Sync

Runs on your Mac. Reads `~/Library/Messages/chat.db` (read-only), filters to a single configured group chat, and POSTs new messages to the Bedrock `/api/imessage/ingest` endpoint.

Nothing outside the configured chat is ever read or transmitted.

## Prerequisites

- macOS with iMessage signed in
- Node 20+ (`node -v`)
- A workspace API key generated from Bedrock (Settings → Coordinator iMessage → Generate API key)
- The `chat.guid` of the group chat you want to sync (the installer lists recent chats and asks you to pick)

## Install

```sh
./install.sh
```

The installer:

1. `npm install`s `better-sqlite3` in this folder.
2. Prompts for Bedrock URL, workspace ID, API key, `chat.guid`, your + cofounder's iMessage handles (labeled "Bedrock"), and a label for the coordinator (default "Jose").
3. Writes `~/.bedrock-imessage/config.json` (mode 600).
4. Installs a launchd agent at `~/Library/LaunchAgents/com.bedrock.imessage-sync.plist` that runs `sync.mjs` every 120 seconds, starting at login.

## Full Disk Access

`chat.db` requires Full Disk Access. On first run, if you see `authorization denied` in `~/.bedrock-imessage/sync.err`, grant Full Disk Access to your Node binary (shown at the end of `install.sh`):

System Settings → Privacy & Security → Full Disk Access → "+" → add the `node` executable.

## Verify

```sh
node sync.mjs --dry-run
```

Prints payload without sending anything.

```sh
tail -f ~/.bedrock-imessage/sync.log
```

Watch the 2-minute cadence.

## Uninstall

```sh
launchctl unload ~/Library/LaunchAgents/com.bedrock.imessage-sync.plist
rm ~/Library/LaunchAgents/com.bedrock.imessage-sync.plist
rm -rf ~/.bedrock-imessage
```

And revoke the API key from Bedrock Settings.

## Caveats

- On iOS 16+, some messages store their body in `attributedBody` (binary NSArchiver) with `text` NULL. v1 skips those and logs a `skipped_attributed` count; reactions, tapbacks, and edits also fall in this bucket. Plain text still syncs.
- State (`last_rowid`) is kept in `~/.bedrock-imessage/state.json`. Deleting it causes a full resync; server-side dedup by iMessage `guid` prevents duplicate rows.
