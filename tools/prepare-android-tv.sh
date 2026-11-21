#!/usr/bin/env bash
set -euo pipefail

adb="${ANDROID_HOME:?}/platform-tools/adb"
if [[ "$1" == authorize ]]; then
  umask 077
  key_dir=$(mktemp -d "${RUNNER_TEMP:?}/battlecity-adb.XXXXXX")
  "$adb" keygen "$key_dir/adbkey"
  {
    printf 'ANDROID_USER_HOME=%s\n' "$key_dir"
    printf 'ANDROID_EMULATOR_HOME=%s\n' "$key_dir"
    printf 'ADB_VENDOR_KEYS=%s/adbkey\n' "$key_dir"
  } >> "${GITHUB_ENV:?}"
  exit 0
fi

case "$2" in
  baseline|comparison-1|comparison-2|comparison-3) ;;
  *) echo "Unsupported device round: $2" >&2; exit 2 ;;
esac
host="build/diagnostics/emulator-api-34/$2"
device="build/diagnostics/api-34/$2"
serial="emulator-$3"

case "$1" in
  prepare)
    mkdir -p "$host"
    rm -f "$host/stop-adb-watch"
    image="$ANDROID_HOME/system-images/android-34/android-tv/x86"
    cp "$image/source.properties" "$host/image.properties" || true
    cp "$image/package.xml" "$host/image-package.xml" || true
    {
      "$adb" version
      "$adb" kill-server || true
      "$adb" start-server
    } > "$host/adb-setup.txt" 2>&1
    # Detach from the action's stdio so its pre-launch command can return.
    nohup bash "$0" watch "$2" "$3" </dev/null > "$host/adb-startup.txt" 2>&1 &
    ;;
  watch)
    deadline=$((SECONDS + 600))
    while [[ "$SECONDS" -lt "$deadline" && ! -f "$host/stop-adb-watch" && ! -f "$device/runner-started" ]]; do
      date -u +%FT%TZ
      timeout 5s "$adb" devices -l || true
      timeout 5s "$adb" -s "$serial" get-state || true
      sleep 5
    done
    ;;
  *) echo "Unsupported Android TV preparation command: $1" >&2; exit 2 ;;
esac
