#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: run-android-device-tests.sh 34|37.2}
case "$version" in
  34|37.2) ;;
  *) echo "Unsupported test platform: $version" >&2; exit 2 ;;
esac
export ANDROID_SERIAL="emulator-${EMULATOR_PORT:?Run inside android-emulator-runner}"
results="build/outputs/androidTest-results/api-$version"
reports="build/reports/androidTests/api-$version"
diagnostics="build/diagnostics/api-$version"
rm -rf "$results" "$reports" "$diagnostics" \
  build/outputs/androidTest-results/connected build/reports/androidTests/connected
mkdir -p "$results" "$reports" "$diagnostics"

collect_results() {
  status=$?
  trap - EXIT
  adb logcat -d -v threadtime > "$diagnostics/device-logcat.txt" 2>&1 || true
  if [[ -d build/outputs/androidTest-results/connected ]]; then
    cp -a build/outputs/androidTest-results/connected/. "$results/" || status=1
  fi
  if [[ -d build/reports/androidTests/connected ]]; then
    cp -a build/reports/androidTests/connected/. "$reports/" || status=1
  fi
  exit "$status"
}
trap collect_results EXIT

actual=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
[[ "$actual" == "${version%%.*}" ]] || { echo "Expected API $version, found $actual" >&2; exit 1; }
if [[ "$version" == 37.2 ]]; then
  minor=$(adb shell getprop ro.build.version.sdk_minor | tr -d '\r')
  [[ "$minor" == 2 ]] || { echo "Expected SDK minor 2, found $minor" >&2; exit 1; }
fi
adb logcat -c
bash ./gradlew connectedDebugAndroidTest --stacktrace
