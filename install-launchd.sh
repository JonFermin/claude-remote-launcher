#!/usr/bin/env bash
# Install Claude Remote Launcher as a macOS launchd service
# Starts at login, restarts on failure (10s delay)
#
# Usage: bash install-launchd.sh
# Uninstall: launchctl unload ~/Library/LaunchAgents/com.claude.remote-launcher.plist && rm ~/Library/LaunchAgents/com.claude.remote-launcher.plist

set -e

LABEL="com.claude.remote-launcher"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
NODE_PATH="$(which node)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PATH="$SCRIPT_DIR/server.js"
LOG_DIR="$HOME/Library/Logs/claude-remote-launcher"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# Unload existing if present
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SERVER_PATH</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST"

echo "Service '$LABEL' installed and started."
echo "Logs: $LOG_DIR/"
echo "To stop:    launchctl unload $PLIST"
echo "To restart: launchctl unload $PLIST && launchctl load $PLIST"
echo "To remove:  launchctl unload $PLIST && rm $PLIST"
