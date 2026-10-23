#!/bin/bash
# Remove the Reactor daemon and restore automatic fan control.
# Run with sudo:  sudo ./uninstall.sh
set -euo pipefail

DEST="/Library/Application Support/Reactor"
PLIST="/Library/LaunchDaemons/com.ash.reactord.plist"
LABEL="com.ash.reactord"
LOG="/Library/Logs/Reactor.log"

say() { printf '%s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "uninstall.sh: run this with sudo" >&2; exit 1; }

if launchctl print "system/$LABEL" >/dev/null 2>&1; then
    say "stopping the daemon"
    launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
    sleep 1
fi

# Belt and braces: give the fans back to macOS even if the daemon never ran.
if [ -x "$DEST/smcfan" ]; then
    say "restoring automatic fan control"
    "$DEST/smcfan" auto >/dev/null 2>&1 || true
fi

say "removing $PLIST"
rm -f "$PLIST"

say "removing $DEST"
rm -rf "$DEST"

say "done. The log is kept at $LOG"
