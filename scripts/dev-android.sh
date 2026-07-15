#!/usr/bin/env bash
#
# dev-android.sh — Build and run the Android app, booting an emulator first
# if no device is already connected.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

has_connected_device() {
  adb devices | awk 'NR>1 && $2=="device" {found=1} END {exit !found}'
}

boot_emulator_if_needed() {
  if has_connected_device; then
    ok "Device already connected"
    return
  fi

  local avd
  avd=$(emulator -list-avds | head -1)
  [[ -n "$avd" ]] || fail "No connected device and no AVD found (create one in Android Studio's Device Manager)"

  info "No connected device — booting emulator ($avd)..."
  nohup emulator -avd "$avd" > /tmp/intention-emulator.log 2>&1 &

  info "Waiting for emulator to boot..."
  for i in $(seq 1 60); do
    if has_connected_device && [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      ok "Emulator booted"
      return
    fi
    sleep 5
  done
  fail "Emulator did not finish booting in time"
}

boot_emulator_if_needed

./build.sh --android
cd "Intention Android"
./gradlew installDebug
adb shell am start -n uk.co.maybeitssoftware.intention/.MainActivity
