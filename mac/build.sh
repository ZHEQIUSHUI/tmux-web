#!/bin/sh
# Build tmux-web.app (Apple silicon + Intel) on a Mac with the Xcode command line tools:
#   ./build.sh            → build/tmux-web.app and build/tmux-web-mac.zip
# Not signed with a developer ID: the first launch needs right-click → 打开.
set -e
cd "$(dirname "$0")"
VERSION=${VERSION:-1.0}
ARCHS="--arch arm64 --arch x86_64"
EASYTIER_VERSION=2.6.4
EASYTIER_BASE_URL=${EASYTIER_BASE_URL:-https://github.com/EasyTier/EasyTier/releases/download/v$EASYTIER_VERSION}
swift build -c release $ARCHS
BIN="$(swift build -c release $ARCHS --show-bin-path)/TmuxWeb"

APP=build/tmux-web.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TmuxWeb"

# EasyTier Core, pinned by version and checksum. Both slices are kept so the universal app works
# on Apple silicon and Intel without downloading anything at runtime.
ET_CACHE=".build/easytier"
mkdir -p "$ET_CACHE" "$APP/Contents/Resources/EasyTier/arm64" "$APP/Contents/Resources/EasyTier/x86_64"
fetch_easytier() {
  arch="$1"
  file="$2"
  sum="$3"
  zip="$ET_CACHE/$file"
  if [ ! -f "$zip" ] || ! printf '%s  %s\n' "$sum" "$zip" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "downloading EasyTier $EASYTIER_VERSION ($arch)…"
    curl -fL --retry 3 --connect-timeout 20 -o "$zip.part" "$EASYTIER_BASE_URL/$file"
    printf '%s  %s\n' "$sum" "$zip.part" | shasum -a 256 -c - >/dev/null || {
      echo "EasyTier $arch 下载校验失败" >&2
      exit 1
    }
    mv "$zip.part" "$zip"
  fi
  dest="$APP/Contents/Resources/EasyTier/$arch/easytier-core"
  unzip -p "$zip" '*/easytier-core' > "$dest"
  test -s "$dest" || { echo "EasyTier $arch 压缩包里没有 easytier-core" >&2; exit 1; }
  chmod 755 "$dest"
}
fetch_easytier arm64 "easytier-macos-aarch64-v$EASYTIER_VERSION.zip" "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b"
fetch_easytier x86_64 "easytier-macos-x86_64-v$EASYTIER_VERSION.zip" "89fc28a6e6995259d76ce3f11775220e8a21c760e94df91a6a9db30a69b6982e"
cp ThirdParty/EasyTier-LICENSE "$APP/Contents/Resources/EasyTier/EasyTier-LICENSE"
cp THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/EasyTier/THIRD_PARTY_NOTICES.md"

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
