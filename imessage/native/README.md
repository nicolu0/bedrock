# MessagesHelper bundle

Tiny `arm64e` dylib that gets DYLD-injected into Messages.app and exposes
private `IMCore` calls — typing indicators and read receipts — over a TCP
loopback connection back to the Node agent.

## Why this architecture

- **Why injection?** AppleScript can send and read iMessages, but it cannot
  toggle typing dots or fire read receipts. Those are emitted by Messages.app
  itself when it calls private methods on `IMChat`. The only way to make those
  signals fire from the outside is to load code into Messages.app that calls
  those methods. That's what this dylib is.
- **Why the helper connects out, not the other way around?** Messages.app is
  sandboxed. The sandbox profile blocks `bind`/`listen` (no `network.server`
  entitlement), so an in-process server is impossible. But `network.client` is
  allowed — outbound `connect` works. So the Node-side agent runs the listener
  on `127.0.0.1:9772` and the helper dials in.
- **Why arm64e?** Messages.app on Apple Silicon ships as arm64e (PAC pointer
  ABI). DYLD won't load an arm64-only library into an arm64e host. The user's
  `-arm64e_preview_abi` boot-arg already permits third-party arm64e binaries.

## One-time host setup

These are required because Messages.app is hardened-runtime and the kernel
otherwise blocks unsigned dylibs from being inserted. The setup is permissive
on this Mac mini specifically — don't replicate on a daily-driver machine.

1. **Disable Library Validation** (no reboot needed for the command itself; the
   change applies to processes launched after):
   ```
   sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true
   ```
2. **Disable SIP fully.** Reboot to Recovery (hold power → **Options** →
   **Continue**), open **Utilities → Terminal**, run:
   ```
   csrutil disable
   ```
   Reboot. Verify: `csrutil status` shows `disabled`.
3. **Set the arm64e preview ABI boot-arg** (only if not already set; check with
   `nvram boot-args`). From Recovery Terminal:
   ```
   nvram boot-args="-arm64e_preview_abi"
   ```

After these three, the host kernel will let dyld insert our unsigned arm64e
dylib into Messages.app.

## Build & run

```
# build the dylib (and the .bundle, kept around in case we ever want to
# revisit the MacForge route)
cd imessage/native/MessagesHelper && make

# in one terminal: launch Messages with the helper injected
imessage/native/run-messages.sh

# in another terminal: run the agent (it listens on :9772 and waits for the
# helper to dial in, which happens within a second of Messages launching)
node imessage/textingux.mjs
```

`textingux.mjs` will print `helper online (Messages.app pid=…)` once the
helper has dialed in and responded to a ping.

## Wire format

The helper is a JSON-line client. The agent (Node side) is the server.

```
agent  -> helper: {"id":1,"op":"ping"}\n
helper -> agent : {"id":1,"ok":true,"pid":12345}\n

agent  -> helper: {"id":2,"op":"markRead","chatGuid":"iMessage;-;+15551234567"}\n
helper -> agent : {"id":2,"ok":true}\n

agent  -> helper: {"id":3,"op":"setTyping","chatGuid":"iMessage;-;+15551234567","typing":true}\n
helper -> agent : {"id":3,"ok":true}\n
```

The helper reconnects with backoff if the agent restarts; in-flight requests
get rejected as `helper disconnected` so callers don't hang.

## Troubleshooting

- **`+load` never logs** in Console (filter on `MessagesHelper`):
  - `csrutil status` not `disabled`? Re-do step 2.
  - DisableLibraryValidation not set? Re-run the `defaults write` (it lives in
    `/Library/Preferences/`, owned by root).
  - Bundle architecture mismatch? `lipo -info MessagesHelper.dylib` should say
    `arm64e` (not `arm64`).
- **`+load` logs but helper never connects to the agent**: agent isn't
  listening on `:9772` yet. Run `node imessage/textingux.mjs` first, or check
  `lsof -i :9772`.
- **`chat not found` errors**: the chat hasn't been opened in Messages.app
  this session — `IMChatRegistry` only knows about chats it has loaded. Send
  or receive one message in that thread to populate it, then retry.
- **Macs OS update broke it**: private IMCore method signatures change between
  major macOS versions. Re-check `setLocalUserIsTyping:` and
  `markAllMessagesAsRead` exist on `IMChat` via class-dump or by cross-
  referencing the bluebubbles-helper headers for the new version.

## File layout

```
imessage/native/
├── README.md
├── run-messages.sh                — launches Messages.app with DYLD_INSERT_LIBRARIES
└── MessagesHelper/
    ├── Makefile                   — clang -arch arm64e, ad-hoc codesign
    ├── Info.plist                 — present so the .bundle build still works
    ├── MessagesHelper.m           — +load → connect-loop → IMChatRegistry calls
    ├── MessagesHelper.dylib       — built, the thing we DYLD-inject
    └── MessagesHelper.bundle/     — built, unused at runtime; kept for posterity
```
