#!/bin/bash
# Install the MLX Transcription service as a macOS LaunchAgent.
# This makes it auto-start on login and auto-restart on crash — no manual intervention needed.
#
# Usage: ./scripts/install-transcription-service.sh
# To uninstall: ./scripts/install-transcription-service.sh --uninstall

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.oasis.transcription"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/oasis"

if [ "$1" = "--uninstall" ]; then
    echo "🛑  Uninstalling Oasis transcription service..."
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "   Removed $PLIST_PATH"
    echo "✅  Uninstalled."
    exit 0
fi

# Determine Python path
PYTHON="${PROJECT_ROOT}/.venv/bin/python"
if [ ! -f "$PYTHON" ]; then
    PYTHON="$(which python3)"
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

echo "🎙️  Installing Oasis MLX Transcription as macOS LaunchAgent..."
echo "   Label:   $LABEL"
echo "   Python:  $PYTHON"
echo "   Project: $PROJECT_ROOT"
echo "   Logs:    $LOG_DIR/transcription.log"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON}</string>
        <string>-m</string>
        <string>uvicorn</string>
        <string>services.transcription.main:app</string>
        <string>--host</string>
        <string>0.0.0.0</string>
        <string>--port</string>
        <string>8099</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONPATH</key>
        <string>${PROJECT_ROOT}</string>
        <key>PATH</key>
        <string>${PROJECT_ROOT}/.venv/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/transcription.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/transcription.log</string>
</dict>
</plist>
PLIST

# Load the service
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo ""
echo "✅  Installed and started!"
echo "   The transcription service will now:"
echo "   • Auto-start when you log in"
echo "   • Auto-restart if it crashes (with 5s throttle)"
echo "   • Run on port 8099"
echo ""
echo "   Check status:  launchctl print gui/$(id -u)/${LABEL}"
echo "   View logs:     tail -f $LOG_DIR/transcription.log"
echo "   Uninstall:     ./scripts/install-transcription-service.sh --uninstall"
