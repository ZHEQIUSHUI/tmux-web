#!/usr/bin/env bash
# Builds the bundled EasyTier JNI libraries for the Android APK. Run from anywhere.
# Only arm64-v8a is built by default; set EASYTIER_ABIS="arm64-v8a x86_64" for more.
set -euo pipefail

# Non-login shells (CI, IDE tasks) often do not have Rust on PATH yet.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${EASYTIER_VERSION:-2.6.4}"
COMMIT="8428a89d2dabc94c97d370ec607c6ca142473626"
SRC="${EASYTIER_SRC:-$ROOT/build/easytier-src}"
OUT="$ROOT/app/src/main/jniLibs"
ABIS="${EASYTIER_ABIS:-arm64-v8a}"

if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git clone --filter=blob:none --branch "v$VERSION" --single-branch https://github.com/EasyTier/EasyTier.git "$SRC"
fi
git -C "$SRC" checkout --detach "$COMMIT"
test "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" || {
  echo "EasyTier source commit mismatch" >&2
  exit 1
}

# The official JNI initializes Android logging at Debug, and EasyTier prints the whole config
# (including network_secret) at info/debug. Keep only warnings and errors in logcat.
JNI_SOURCE="$SRC/easytier-contrib/easytier-android-jni/src/lib.rs"
sed 's/with_max_level(log::LevelFilter::Debug)/with_max_level(log::LevelFilter::Warn)/' \
  "$JNI_SOURCE" > "$JNI_SOURCE.tmp"
mv "$JNI_SOURCE.tmp" "$JNI_SOURCE"
grep -q 'with_max_level(log::LevelFilter::Warn)' "$JNI_SOURCE" || {
  echo "could not quiet the EasyTier JNI logger" >&2
  exit 1
}

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_NDK_ROOT:-}" ]; then
  ANDROID_NDK_HOME="$(ls -d "${ANDROID_HOME:?ANDROID_HOME is not set}"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
  export ANDROID_NDK_HOME
fi
test -n "${ANDROID_NDK_HOME:-}" || {
  echo "Android NDK not found; set ANDROID_NDK_HOME or ANDROID_NDK_ROOT" >&2
  exit 1
}

if command -v rustup >/dev/null 2>&1; then
  # EasyTier pins Rust in rust-toolchain.toml, so run rustup inside the source tree.
  # Installing the targets on the default toolchain would not help the pinned one.
  for target in aarch64-linux-android; do
    (cd "$SRC" && rustup target list --installed | grep -qx "$target") || \
      (cd "$SRC" && rustup target add "$target")
  done
  if printf '%s\n' "$ABIS" | grep -q x86_64; then
    (cd "$SRC" && rustup target list --installed | grep -qx x86_64-linux-android) || \
      (cd "$SRC" && rustup target add x86_64-linux-android)
  fi
fi
cargo ndk --version >/dev/null 2>&1 || {
  echo "cargo-ndk is required: cargo install cargo-ndk --locked" >&2
  exit 1
}
command -v patchelf >/dev/null 2>&1 || {
  echo "patchelf is required to link the JNI library to libeasytier_ffi.so" >&2
  exit 1
}

# kcp-sys uses bindgen. Debian/Ubuntu commonly place libclang in an LLVM directory that
# is not on the loader's default search path.
if [ -z "${LIBCLANG_PATH:-}" ]; then
  for dir in /usr/lib/llvm-*/lib /usr/lib/*-linux-gnu; do
    if compgen -G "$dir/libclang.so*" >/dev/null || compgen -G "$dir/libclang-[0-9]*.so*" >/dev/null; then
      export LIBCLANG_PATH="$dir"
      break
    fi
  done
fi
if [ -z "${LIBCLANG_PATH:-}" ] && ! ldconfig -p 2>/dev/null | grep 'libclang-[0-9].*\.so' >/dev/null; then
  echo "libclang is required by EasyTier's kcp-sys: install libclang-dev" >&2
  exit 1
fi

# EasyTier's build script needs protoc with proto3 optional support (>= 3.12). Some older
# distributions still ship 3.6, so use a pinned copy on Linux x86_64 (CI and the dev machine).
if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  PROTOC_VERSION=3.20.3
  PROTOC_DIR="$ROOT/build/protoc-$PROTOC_VERSION"
  if [ ! -x "$PROTOC_DIR/bin/protoc" ]; then
    mkdir -p "$PROTOC_DIR"
    ARCHIVE="$PROTOC_DIR/protoc.zip"
    curl -fsSL -o "$ARCHIVE" \
      "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOC_VERSION/protoc-$PROTOC_VERSION-linux-x86_64.zip"
    echo "44a6b498e996b845edef83864734c0e52f42197e85c9d567af55f4e3ff09d755  $ARCHIVE" | sha256sum -c - >/dev/null
    unzip -oq "$ARCHIVE" -d "$PROTOC_DIR"
    rm -f "$ARCHIVE"
  fi
  export PROTOC="$PROTOC_DIR/bin/protoc"
elif ! command -v protoc >/dev/null 2>&1; then
  echo "protoc >= 3.12 is required (protobuf-compiler)" >&2
  exit 1
fi

mkdir -p "$OUT"
for abi in $ABIS; do
  echo "building EasyTier for $abi"
  (cd "$SRC" && cargo ndk -t "$abi" --platform 26 -o "$OUT" build --release -p easytier-ffi)
  (cd "$SRC" && cargo ndk -t "$abi" --platform 26 -o "$OUT" build --release -p easytier-android-jni)
  test -s "$OUT/$abi/libeasytier_ffi.so"
  test -s "$OUT/$abi/libeasytier_android_jni.so"
  # The upstream JNI crate declares the FFI calls as extern but does not add an ELF dependency.
  # Android loads native libraries with RTLD_LOCAL, so relying on load order is not enough.
  if ! readelf -d "$OUT/$abi/libeasytier_android_jni.so" | grep -q 'Shared library: \[libeasytier_ffi.so\]'; then
    patchelf --add-needed libeasytier_ffi.so "$OUT/$abi/libeasytier_android_jni.so"
  fi
  readelf -d "$OUT/$abi/libeasytier_android_jni.so" | grep -q 'Shared library: \[libeasytier_ffi.so\]' || {
    echo "could not link $abi JNI library to libeasytier_ffi.so" >&2
    exit 1
  }
done

echo "EasyTier JNI built in $OUT"
