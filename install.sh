#!/bin/bash
# Install the Reactor fan-control daemon. Run with sudo from the repo folder:
#
#   sudo ./install.sh
#
# Optional environment variables:
#   MACMON=/path/to/macmon   use a specific macmon binary
#   PORT=7979                HTTP port (default 7979)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="/Library/Application Support/Reactor"
PLIST="/Library/LaunchDaemons/com.ash.reactord.plist"
LABEL="com.ash.reactord"
LOG="/Library/Logs/Reactor.log"
PORT="${PORT:-7979}"
PYTHON="/usr/bin/python3"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo: sudo ./install.sh"
[ -x "$PYTHON" ] || die "$PYTHON not found; install the Command Line Tools first"

# --- stop anything that fights us for the fans ----------------------------
if pgrep -x "Macs Fan Control" >/dev/null 2>&1; then
    say "stopping Macs Fan Control"
    pkill -x "Macs Fan Control" || true
    sleep 1
fi

# --- stop an older copy of the daemon -------------------------------------
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
    say "stopping the existing reactor daemon"
    launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
    sleep 1
fi

# --- build the helper if needed -------------------------------------------
if [ ! -x "$ROOT/smc/smcfan" ]; then
    say "building smcfan"
    ( cd "$ROOT" && ./smc/build.sh )
fi
[ -x "$ROOT/smc/smcfan" ] || die "smc/smcfan is missing; run ./smc/build.sh"
[ -f "$ROOT/daemon/reactord.py" ] || die "daemon/reactord.py is missing"

# --- pick a macmon --------------------------------------------------------
MACMON_SRC="${MACMON:-}"
if [ -z "$MACMON_SRC" ]; then
    MACMON_SRC="$(command -v macmon || true)"
fi
if [ -z "$MACMON_SRC" ] && [ -x "/opt/homebrew/bin/macmon" ]; then
    MACMON_SRC="/opt/homebrew/bin/macmon"
fi
if [ -z "$MACMON_SRC" ] && [ -x "$DEST/macmon" ]; then
    MACMON_SRC="$DEST/macmon"
fi
[ -n "$MACMON_SRC" ] && [ -x "$MACMON_SRC" ] || \
    die "macmon not found; install it (brew install macmon) or set MACMON=/path/to/macmon"

# --- install files --------------------------------------------------------
say "installing into $DEST"
mkdir -p "$DEST" "$DEST/ui" /Library/Logs
chmod 755 "$DEST" "$DEST/ui" /Library/Logs

install -m 755 -o root -g wheel "$ROOT/smc/smcfan" "$DEST/smcfan"
if [ "$MACMON_SRC" != "$DEST/macmon" ]; then
    install -m 755 -o root -g wheel "$MACMON_SRC" "$DEST/macmon"
fi
install -m 644 -o root -g wheel "$ROOT/daemon/reactord.py" "$DEST/reactord.py"

rm -rf "$DEST/ui"
mkdir -p "$DEST/ui"
if [ -d "$ROOT/ui" ] && [ -n "$(ls -A "$ROOT/ui" 2>/dev/null)" ]; then
    cp -R "$ROOT/ui/." "$DEST/ui/"
else
    say "warning: ui/ is empty; the app will show 'UI folder is not installed'"
fi

# Permissions: 755 dirs, 644 files, 755 binaries. config.json is preserved.
find "$DEST" -type d -exec chmod 755 {} +
find "$DEST" -type f -exec chmod 644 {} +
chmod 755 "$DEST/smcfan" "$DEST/macmon"
chown -R root:wheel "$DEST"

# --- launchd job ----------------------------------------------------------
say "writing $PLIST"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON}</string>
        <string>${DEST}/reactord.py</string>
        <string>--smcfan</string>
        <string>${DEST}/smcfan</string>
        <string>--macmon</string>
        <string>${DEST}/macmon</string>
        <string>--ui</string>
        <string>${DEST}/ui</string>
        <string>--state-dir</string>
        <string>${DEST}</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>WorkingDirectory</key>
    <string>${DEST}</string>
    <key>StandardOutPath</key>
    <string>${LOG}</string>
    <key>StandardErrorPath</key>
    <string>${LOG}</string>
</dict>
</plist>
PLIST

chown root:wheel "$PLIST"
chmod 644 "$PLIST"
touch "$LOG"
chown root:wheel "$LOG"
chmod 644 "$LOG"

say "loading the daemon"
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true

# --- health check (no curl) ----------------------------------------------
say "checking http://127.0.0.1:$PORT/api/state"
if "$PYTHON" - "$PORT" <<'PY'
import json
import sys
import time
import urllib.request

port = sys.argv[1]
url = "http://127.0.0.1:%s/api/state" % port
last = None
for _ in range(10):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            state = json.loads(response.read().decode("utf-8"))
        fans = state.get("fans") or []
        print("OK  temp=%s C  fans=%d  mode=%s" % (
            state.get("temp_c"), len(fans), state.get("mode")))
        sys.exit(0)
    except Exception as exc:  # not up yet
        last = exc
        time.sleep(1)
print("reactord did not answer: %s" % last, file=sys.stderr)
sys.exit(1)
PY
then
    say "Reactor is running. Open app/build/Reactor.app or http://127.0.0.1:$PORT/"
else
    say "the daemon did not come up; last lines of $LOG:"
    tail -n 20 "$LOG" >&2 || true
    die "installation finished but the health check failed"
fi
