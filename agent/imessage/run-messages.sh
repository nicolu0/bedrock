#!/bin/bash
# Launch Messages.app with our helper dylib injected. Use this instead of
# `open -a Messages` whenever you want the agent to have IMCore access (typing
# dots, read receipts).
#
# Requires: SIP fully disabled + DisableLibraryValidation=true (one-time setup,
# see README.md).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DYLIB="$HERE/MessagesHelper/MessagesHelper.dylib"

if [[ ! -f "$DYLIB" ]]; then
	echo "Helper dylib not built. Run: cd $HERE/MessagesHelper && make" >&2
	exit 1
fi

# Enforce a single Messages instance. `osascript quit` only catches one
# AppleScript-registered instance and can't kill a DYLD-injected zombie, so two
# instances could survive and fight over the helper socket (connect storm).
# pkill -x matches every process named exactly "Messages"; wait until they're
# all gone before launching so we never start alongside a survivor.
pkill -x Messages 2>/dev/null || true
for _ in $(seq 1 50); do
	pgrep -x Messages >/dev/null 2>&1 || break
	sleep 0.1
done

# Foreground launch with our dylib injected. Messages.app spams stdout/stderr
# with internal debug strings ("uh oh.", SwiftUI font warnings, etc.) that have
# nothing to do with us — silence them. Our helper logs go through os_log and
# are visible via:  log show --predicate 'subsystem == "com.bedrock.MessagesHelper"'
exec env DYLD_INSERT_LIBRARIES="$DYLIB" \
	/System/Applications/Messages.app/Contents/MacOS/Messages "$@" >/dev/null 2>&1
