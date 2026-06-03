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
</dict>
</plist>
PLIST

echo "→ ad-hoc codesign (required for SMAppService login-item registration)"
codesign --force --deep --sign - "$APP" 2>&1 | sed 's/^/  /' || true

echo "✓ built $APP"
echo ""
echo "Install: cp -r \"$APP\" /Applications/"
echo "Run:     open \"$APP\""
