#!/usr/bin/env bash
# Build whisper-cli for macOS and stage it as a Tauri externalBin.
#
# whisper.cpp publishes Windows command-line builds but no macOS one, so the
# Mac app ships its own: the same pinned release the Windows app downloads
# (b4938), compiled here as ONE universal (arm64 + x86_64) static binary with
# the Metal shaders embedded - no dylibs or .metal files to bundle beside it.
#
#   scripts/build-whisper-macos.sh            # -> src-tauri/binaries/whisper-cli-<triple>
#
# Portable on purpose: GGML_NATIVE=OFF, or the binary would use whatever the
# CI machine's CPU supports and crash with an illegal instruction elsewhere.
set -euo pipefail

TAG="b4938"
COMMIT="371b5a7561823ab2bb32142d2751e35e7534727b"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WHISPER_WORK:-$ROOT/src-tauri/target/whisper-build}"
OUT="$ROOT/src-tauri/binaries"

mkdir -p "$WORK" "$OUT"
if [ ! -d "$WORK/src/.git" ]; then
  git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$WORK/src"
fi
got="$(git -C "$WORK/src" rev-parse HEAD)"
if [ "$got" != "$COMMIT" ]; then
  echo "whisper.cpp $TAG resolved to $got, expected $COMMIT - refusing to build" >&2
  exit 1
fi

if [ ! -x "$WORK/build/bin/whisper-cli" ]; then
  cmake -S "$WORK/src" -B "$WORK/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_SDL2=OFF
  cmake --build "$WORK/build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)"
fi

BIN="$WORK/build/bin/whisper-cli"
lipo -info "$BIN"
lipo -info "$BIN" | grep -q arm64  || { echo "whisper-cli is missing the arm64 slice" >&2; exit 1; }
lipo -info "$BIN" | grep -q x86_64 || { echo "whisper-cli is missing the x86_64 slice" >&2; exit 1; }
# Static: nothing beyond the system's own libraries and frameworks.
if otool -L "$BIN" | tail -n +2 | grep -v -E '^\s*(/usr/lib/|/System/Library/)'; then
  echo "whisper-cli links something outside the OS" >&2
  exit 1
fi

# Tauri looks for <name>-<target triple>; the universal binary serves all three.
for triple in aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin; do
  cp "$BIN" "$OUT/whisper-cli-$triple"
  chmod 755 "$OUT/whisper-cli-$triple"
done
echo "staged whisper-cli ($TAG) in $OUT"
