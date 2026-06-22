#!/usr/bin/env bash
#
# build.sh — Build Intention browser extension packages on macOS
#
# Usage:
#   ./build.sh           Build Chrome + Firefox zips
#   ./build.sh --all     Build Chrome + Firefox zips + Safari Xcode project
#   ./build.sh --safari  Build Safari Xcode project only
#
# Output goes to build/ directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CHROME_DIR="Intention Chrome"
FIREFOX_DIR="Intention Firefox"
APPLE_DIR="Intention Apple"
APPLE_EXT_DIR="$APPLE_DIR/Shared (Extension)/Resources"
BUILD_DIR="build"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

preflight() {
  # Verify directories exist
  [[ -d "$CHROME_DIR" ]]  || fail "Missing $CHROME_DIR directory"
  [[ -d "$FIREFOX_DIR" ]] || fail "Missing $FIREFOX_DIR directory"

  # Extract version from Chrome manifest
  VERSION=$(python3 -c "import json; print(json.load(open('$CHROME_DIR/manifest.json'))['version'])")
  [[ -n "$VERSION" ]] || fail "Could not read version from manifest.json"

  info "Version: $VERSION"

  # Verify cross-platform sync (shared files must be identical)
  SHARED_FILES=(
    content.css content.js options.css options.html options.js
    coaching.html coaching.js background.js prompts.js providers.js tracking.js
  )

  SYNC_OK=true
  for f in "${SHARED_FILES[@]}"; do
    if ! diff -q "$CHROME_DIR/$f" "$FIREFOX_DIR/$f" > /dev/null 2>&1; then
      warn "Out of sync (Chrome ↔ Firefox): $f"
      SYNC_OK=false
    fi
    if [[ -d "$APPLE_EXT_DIR" ]] && ! diff -q "$CHROME_DIR/$f" "$APPLE_EXT_DIR/$f" > /dev/null 2>&1; then
      warn "Out of sync (Chrome ↔ Apple): $f"
      SYNC_OK=false
    fi
  done

  if ! $SYNC_OK; then
    fail "Shared files are out of sync across platforms. Fix before building."
  fi
  ok "Cross-platform sync verified"

  # Validate manifests
  python3 -c "import json; json.load(open('$CHROME_DIR/manifest.json'))"  || fail "Invalid Chrome manifest.json"
  python3 -c "import json; json.load(open('$FIREFOX_DIR/manifest.json'))" || fail "Invalid Firefox manifest.json"
  ok "Manifests valid"

  # Check JS syntax
  JS_OK=true
  for f in "$CHROME_DIR"/*.js; do
    if ! node --check "$f" 2>/dev/null; then
      warn "Syntax error: $f"
      JS_OK=false
    fi
  done
  if ! $JS_OK; then
    fail "JavaScript syntax errors found. Fix before building."
  fi
  ok "JS syntax OK"
}

# ---------------------------------------------------------------------------
# Build Chrome + Firefox zips
# ---------------------------------------------------------------------------

build_extensions() {
  mkdir -p "$BUILD_DIR"

  info "Building Chrome extension..."
  (cd "$CHROME_DIR" && zip -r -q "../$BUILD_DIR/intention-chrome-v${VERSION}.zip" . -x "env.txt" "*.DS_Store")
  ok "intention-chrome-v${VERSION}.zip"

  info "Building Firefox extension..."
  (cd "$FIREFOX_DIR" && zip -r -q "../$BUILD_DIR/intention-firefox-v${VERSION}.zip" . -x "env.txt" "*.DS_Store")
  ok "intention-firefox-v${VERSION}.zip"
}

# ---------------------------------------------------------------------------
# Build Safari (Xcode)
# ---------------------------------------------------------------------------

build_safari() {
  if [[ ! -d "$APPLE_DIR/Intention Safari.xcodeproj" ]]; then
    warn "Xcode project not found — regenerating Safari wrapper..."
    xcrun safari-web-extension-converter "./$CHROME_DIR" \
      --project-location . \
      --app-name "Intention Safari" \
      --no-open
    ok "Safari wrapper regenerated"
  fi

  info "Building Safari extension (macOS)..."
  xcodebuild \
    -project "$APPLE_DIR/Intention Safari.xcodeproj" \
    -scheme "Intention Safari (macOS)" \
    -configuration Release \
    -derivedDataPath "$BUILD_DIR/safari-derived" \
    -quiet \
    build
  ok "Safari macOS build complete"

  # Copy the .app if it exists
  APP_PATH=$(find "$BUILD_DIR/safari-derived" -name "*.app" -maxdepth 5 | head -1)
  if [[ -n "$APP_PATH" ]]; then
    cp -R "$APP_PATH" "$BUILD_DIR/"
    ok "Copied $(basename "$APP_PATH") to $BUILD_DIR/"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local do_extensions=false
  local do_safari=false

  case "${1:-}" in
    --all)    do_extensions=true; do_safari=true ;;
    --safari) do_safari=true ;;
    *)        do_extensions=true ;;
  esac

  echo ""
  echo "  ╔══════════════════════════════════╗"
  echo "  ║   Intention — Build Script       ║"
  echo "  ╚══════════════════════════════════╝"
  echo ""

  preflight

  if $do_extensions; then
    build_extensions
  fi

  if $do_safari; then
    build_safari
  fi

  echo ""
  ok "Build complete → ./$BUILD_DIR/"
  ls -lh "$BUILD_DIR"/ 2>/dev/null | grep -v "^total" | grep -v "safari-derived" || true
  echo ""
}

main "$@"
