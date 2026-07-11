#!/usr/bin/env bash
#
# build.sh — Build Intention browser extension packages on macOS
#
# Usage:
#   ./build.sh           Build Chrome + Firefox zips
#   ./build.sh --all     Build Chrome + Firefox zips + Safari Xcode project + iOS + Android
#   ./build.sh --safari  Build Safari Xcode project only
#   ./build.sh --ios     Build + run Safari extension on iOS Simulator
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

  # Verify version sync across manifests (all generated from shared/manifest.base.json)
  BASE_VERSION=$(python3 -c "import json; print(json.load(open('shared/manifest.base.json'))['version'])")
  [[ "$VERSION" == "$BASE_VERSION" ]] || fail "Version mismatch: shared/manifest.base.json=$BASE_VERSION Chrome=$VERSION (run scripts/sync.sh)"

  # Verify Safari Xcode project version matches, if present
  APPLE_PBXPROJ="$APPLE_DIR/Intention Safari.xcodeproj/project.pbxproj"
  if [[ -f "$APPLE_PBXPROJ" ]]; then
    APPLE_VERSIONS=$(grep -oE "MARKETING_VERSION = [0-9.]+;" "$APPLE_PBXPROJ" | sed -E 's/MARKETING_VERSION = ([0-9.]+);/\1/' | sort -u)
    APPLE_VERSION_COUNT=$(echo "$APPLE_VERSIONS" | wc -l | tr -d ' ')
    if [[ "$APPLE_VERSION_COUNT" != "1" ]] || [[ "$APPLE_VERSIONS" != "$VERSION" ]]; then
      fail "Safari MARKETING_VERSION ($APPLE_VERSIONS) doesn't match manifest version ($VERSION) — run scripts/bump-version.sh $VERSION"
    fi
    ok "Safari Xcode version matches ($VERSION)"
  fi

  # Verify every platform matches shared/ (single source of truth).
  # On drift: edit shared/, run scripts/sync.sh, never hand-edit platform copies.
  scripts/sync.sh --check || fail "Platforms out of sync with shared/ — run scripts/sync.sh"
  ok "Cross-platform sync verified"

  # Validate generated manifests
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

  # Run the test suite if Node deps are installed. Guarded so a clean checkout
  # without node_modules (or without npm) still builds.
  if command -v npm > /dev/null 2>&1 && [[ -d "node_modules" ]]; then
    info "Running test suite..."
    if npm test --silent; then
      ok "Tests passed"
    else
      fail "Tests failed. Fix before building."
    fi
  else
    warn "Skipping tests (run 'npm install' to enable the test suite in preflight)"
  fi

  # AMO validation (best-effort — requires `npm install` once)
  if [[ -d node_modules/web-ext ]]; then
    info "Linting Firefox extension with web-ext (AMO validation)..."
    if npx --no-install web-ext lint --source-dir="$FIREFOX_DIR"; then
      ok "web-ext lint passed"
    else
      fail "web-ext lint found errors — fix before submitting to addons.mozilla.org"
    fi
  else
    warn "web-ext not installed — skipping AMO lint (run: npm install)"
  fi
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
# Build + run iOS (Simulator)
# ---------------------------------------------------------------------------

build_ios() {
  if [[ ! -d "$APPLE_DIR/Intention Safari.xcodeproj" ]]; then
    warn "Xcode project not found — regenerating Safari wrapper..."
    xcrun safari-web-extension-converter "./$CHROME_DIR" \
      --project-location . \
      --app-name "Intention Safari" \
      --no-open
    ok "Safari wrapper regenerated"
  fi

  info "Building Safari extension (iOS Simulator)..."
  xcodebuild \
    -project "$APPLE_DIR/Intention Safari.xcodeproj" \
    -scheme "Intention Safari (iOS)" \
    -configuration Debug \
    -sdk iphonesimulator \
    -derivedDataPath "$BUILD_DIR/ios-derived" \
    -quiet \
    build
  ok "Safari iOS build complete"

  local app_path
  app_path=$(find "$BUILD_DIR/ios-derived" -name "*.app" -path "*iphonesimulator*" -maxdepth 6 | head -1)
  [[ -n "$app_path" ]] || fail "Could not locate built .app for iOS Simulator"

  local bundle_id
  bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app_path/Info.plist" 2>/dev/null)
  [[ -n "$bundle_id" ]] || fail "Could not read CFBundleIdentifier from $app_path/Info.plist"

  info "Booting iOS Simulator..."
  open -a Simulator

  info "Waiting for simulator to boot..."
  local booted_udid=""
  for i in $(seq 1 30); do
    booted_udid=$(xcrun simctl list devices booted | grep -m1 -oE '[0-9A-F-]{36}' || true)
    [[ -n "$booted_udid" ]] && break
    sleep 1
  done
  [[ -n "$booted_udid" ]] || fail "No booted simulator found after waiting"

  info "Installing on simulator ($booted_udid)..."
  xcrun simctl install booted "$app_path"
  ok "Installed"

  info "Launching $bundle_id..."
  xcrun simctl launch booted "$bundle_id"
  ok "Launched on iOS Simulator"
}

# ---------------------------------------------------------------------------
# Sync Android assets (delegates to the shared/ single source of truth)
# ---------------------------------------------------------------------------

build_android() {
  if [[ -d "Intention Android" ]]; then
    info "Syncing assets to Intention Android..."
    scripts/sync.sh > /dev/null
    ok "Android assets synced complete"
  else
    warn "Android project directory not found, skipping sync"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local do_extensions=false
  local do_safari=false
  local do_ios=false
  local do_android=false

  case "${1:-}" in
    --all)    do_extensions=true; do_safari=true; do_ios=true; do_android=true ;;
    --safari) do_safari=true ;;
    --ios)    do_ios=true ;;
    --android) do_android=true ;;
    *)        do_extensions=true; do_android=true ;;
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

  if $do_ios; then
    build_ios
  fi

  if $do_android; then
    build_android
  fi

  echo ""
  ok "Build complete → ./$BUILD_DIR/"
  ls -lh "$BUILD_DIR"/ 2>/dev/null | grep -v "^total" | grep -v "safari-derived" || true
  echo ""
}

main "$@"

