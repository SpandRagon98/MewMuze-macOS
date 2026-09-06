#!/usr/bin/env bash
# Build the macOS MewMuze app + DMG.
#
# Run this ON A MAC. It cannot run on Windows or Linux: Apple's SDK, linker,
# codesign and hdiutil are macOS-only.
#
#   ./scripts/build-macos.sh              # unsigned universal build
#   SIGN=1 ./scripts/build-macos.sh       # + codesign
#   SIGN=1 NOTARIZE=1 ./scripts/build-macos.sh   # + notarize & staple
#
# Signing/notarising needs these in the environment (never hardcode them):
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID                 your Apple ID email
#   APPLE_PASSWORD           an app-specific password (NOT your Apple ID password)
#   APPLE_TEAM_ID            your 10-character team id

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS builds require macOS. On Windows/Linux this cannot work —" >&2
  echo "       Apple's SDK, linker, codesign and hdiutil are not available." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

command -v cargo >/dev/null || { echo "error: Rust not installed - https://rustup.rs" >&2; exit 1; }
command -v npm   >/dev/null || { echo "error: Node.js not installed" >&2; exit 1; }
xcode-select -p  >/dev/null || { echo "error: Xcode CLT missing - run: xcode-select --install" >&2; exit 1; }

# Universal binary: one app that runs natively on Apple Silicon AND Intel.
rustup target add aarch64-apple-darwin x86_64-apple-darwin

npm ci
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml

BUILD_ARGS=(--target universal-apple-darwin)

if [[ "${SIGN:-0}" == "1" ]]; then
  : "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY to code-sign}"
  echo "==> signing as: $APPLE_SIGNING_IDENTITY"
else
  echo "==> UNSIGNED build. Gatekeeper will warn on other Macs."
  echo "    Users can right-click the app > Open, or you can re-run with SIGN=1."
fi

if [[ "${NOTARIZE:-0}" == "1" ]]; then
  : "${APPLE_ID:?set APPLE_ID to notarize}"
  : "${APPLE_PASSWORD:?set APPLE_PASSWORD (app-specific password) to notarize}"
  : "${APPLE_TEAM_ID:?set APPLE_TEAM_ID to notarize}"
  echo "==> notarisation enabled"
fi

npm run tauri build -- "${BUILD_ARGS[@]}"

OUT="src-tauri/target/universal-apple-darwin/release/bundle"
DMG=$(find "$OUT/dmg" -name '*.dmg' -maxdepth 1 2>/dev/null | head -1 || true)

if [[ -z "$DMG" ]]; then
  echo "error: no .dmg produced - check the build output above" >&2
  exit 1
fi

DIST="dist/MewMuze-macOS"
mkdir -p "$DIST"
cp "$DMG" "$DIST/MewMuze-macOS.dmg"
cp docs/README-macOS.txt "$DIST/README.txt" 2>/dev/null || true

echo
echo "DMG : $DIST/MewMuze-macOS.dmg"
echo "size: $(du -h "$DIST/MewMuze-macOS.dmg" | cut -f1)"
echo "sha256:"
shasum -a 256 "$DIST/MewMuze-macOS.dmg"
echo
echo "Verify before shipping:"
echo "  spctl -a -vvv -t install '$DIST/MewMuze-macOS.dmg'   # Gatekeeper"
echo "  codesign -dv --verbose=4 '$OUT/macos/MewMuze.app'    # signature"
