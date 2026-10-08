#!/bin/sh
# Build tmux-web.app (Apple silicon + Intel) on a Mac with the Xcode command line tools:
#   ./build.sh            → build/tmux-web.app and build/tmux-web-mac.zip
# Not signed with a developer ID: the first launch needs right-click → 打开.
set -e
cd "$(dirname "$0")"
VERSION=${VERSION:-1.0}
ARCHS="--arch arm64 --arch x86_64"
swift build -c release $ARCHS
BIN="$(swift build -c release $ARCHS --show-bin-path)/TmuxWeb"

APP=build/tmux-web.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TmuxWeb"

# the icon, from the web page's
ICON=../src/web/public/icon-512.png
if [ -f "$ICON" ]; then
  SET=build/AppIcon.iconset && mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" && rm -rf "$SET"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.zheqiushui.tmuxweb</string>
  <key>CFBundleName</key><string>tmux-web</string>
  <key>CFBundleDisplayName</key><string>tmux-web</string>
  <key>CFBundleExecutable</key><string>TmuxWeb</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
(cd build && ditto -c -k --keepParent tmux-web.app tmux-web-mac.zip)
echo "built: $(pwd)/$APP  ($(du -sh "$APP" | cut -f1))"
