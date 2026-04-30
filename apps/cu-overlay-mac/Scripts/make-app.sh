#!/usr/bin/env bash
# Bundle the SwiftPM executable into an .app — gives us Info.plist, LSUIElement,
# and a real bundle identifier so launchctl/Finder treat it as a proper app.
#
# Usage:
#   ./Scripts/make-app.sh                          (release build, ad-hoc signed)
#   ./Scripts/make-app.sh debug                    (debug build, ad-hoc signed)

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${1:-release}"
if [[ "$CONFIG" == "release" ]]; then
  swift build -c release
  BIN=".build/release/OasisCUOverlay"
else
  swift build
  BIN=".build/debug/OasisCUOverlay"
fi

APP="OasisCUOverlay.app"
ENTITLEMENTS="OasisCUOverlay.entitlements"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OasisCUOverlay"
cp Info.plist "$APP/Contents/Info.plist"

SIGN_IDENTITY="${OASIS_CODESIGN_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" || -z "$SIGN_IDENTITY" ]]; then
  echo "→ ad-hoc signing (local dev only — not distributable)"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
else
  echo "→ Developer ID signing as: $SIGN_IDENTITY"
  codesign --force \
           --options runtime \
           --timestamp \
           --entitlements "$ENTITLEMENTS" \
           --sign "$SIGN_IDENTITY" \
           "$APP"
  codesign --verify --strict --verbose=2 "$APP"
fi

echo "Built $APP"
echo "Run with:  open $APP --args --session=cu-xxxxxxxx --gateway=8000 --port=8008"
