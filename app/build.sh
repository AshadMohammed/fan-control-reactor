#!/bin/bash
# Build Reactor.app without Xcode. Produces app/build/Reactor.app.
set -euo pipefail

cd "$(dirname "$0")"

APP="build/Reactor.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"

rm -rf "$APP"
mkdir -p "$MACOS" "$CONTENTS/Resources"

echo "compiling ReactorApp.swift"
swiftc -O -swift-version 5 -parse-as-library \
    -framework Cocoa -framework WebKit \
    -o "$MACOS/Reactor" ReactorApp.swift

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>Reactor</string>
    <key>CFBundleIconFile</key>
    <string>Reactor</string>
    <key>CFBundleIdentifier</key>
    <string>com.ash.reactor</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Reactor</string>
    <key>CFBundleDisplayName</key>
    <string>Reactor</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.utilities</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# Optional: the icon lives next to this script (built by make_icns.sh).
if [ -f "Reactor.icns" ]; then
    cp "Reactor.icns" "$CONTENTS/Resources/Reactor.icns"
fi

# Ad-hoc signature so macOS is happy to launch a locally built bundle.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "built $(pwd)/$APP"
