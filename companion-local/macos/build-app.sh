#!/bin/bash
# Build companion-local into a distributable .app bundle.
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Companion Local"
BUNDLE_ID="eu.odyssai.companion-local"
VERSION="0.1.0"
DIST="dist"
APP="$DIST/$APP_NAME.app"

echo "→ swift build -c release"
swift build -c release

BIN=$(swift build -c release --show-bin-path)/CompanionLocal

echo "→ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CompanionLocal"

cat > "$APP/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>CompanionLocal</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- LSUIElement: menubar-only agent, no Dock icon -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Allow plain-HTTP to LAN hosts (e.g. http://192.168.x:3100). Without
       this, ATS interferes with the SSE stream over http. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

echo "→ ad-hoc codesign (single binary, no --deep — --deep corrupts the sig)"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/CompanionLocal" 2>&1 | sed 's/^/  /' || true
codesign --force --sign - --timestamp=none "$APP" 2>&1 | sed 's/^/  /' || true
echo "→ verify"
codesign --verify --strict "$APP" 2>&1 | sed 's/^/  /' && echo "  signature valid"

echo "✓ built $APP"
echo ""
echo "Install: cp -r \"$APP\" /Applications/"
echo "Run:     open \"$APP\""
