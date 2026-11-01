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
  if [[ "$status" != 0 ]]; then
    adb shell dumpsys window windows > "$diagnostics/window-state.txt" 2>&1 || true
  fi
  printf 'Runner exit status: %s\n' "$status" >> "$diagnostics/preflight.txt"
  exit "$status"
}
trap collect_results EXIT

preflight() {
  local property value status failed=0
  local -A values
  printf 'Requested API: %s\n' "$version"
  for property in sdk sdk_full sdk_minor; do
    if value=$(adb shell getprop "ro.build.version.$property" 2>&1); then
      status=0
    else
      status=$?
      if [[ "$failed" == 0 ]]; then failed=$status; fi
    fi
    printf 'adb shell getprop ro.build.version.%s (exit %s):\n%s\n' "$property" "$status" "$value"
    values[$property]=${value//$'\r'/}
  done
  if [[ "$failed" != 0 ]]; then
    echo 'Version preflight failed: could not read device properties' >&2
    return "$failed"
  fi
  if [[ "${values[sdk]}" != "${version%%.*}" ]]; then
    printf 'Expected API %s, found sdk=<%s>\n' "$version" "${values[sdk]}" >&2
    return 1
  fi
  if [[ "$version" == 37.2 ]]; then
    if [[ -n "${values[sdk_full]}" ]]; then
      if [[ "${values[sdk_full]}" != 37.2 ]]; then
        printf 'Expected SDK full 37.2, found sdk_full=<%s>\n' "${values[sdk_full]}" >&2
        return 1
      fi
      echo 'Version source: ro.build.version.sdk_full'
    elif [[ "${values[sdk_minor]}" == 2 ]]; then
      echo 'Version source: legacy ro.build.version.sdk_minor (sdk_full is empty)'
    else
      printf 'Expected SDK minor 2 when sdk_full is empty, found sdk_minor=<%s>\n' "${values[sdk_minor]}" >&2
      return 1
    fi
  fi
  printf 'Verified API %s\n' "$version"
}

prepare_display() {
  local phase value status
  local -a adb_args
  # A fresh phone emulator shows a focus-taking tutorial on its first immersive
  # window. Confirm that system tutorial before testing the game's own focus flow.
  for phase in before write after; do
    adb_args=(shell settings --user current)
    if [[ "$phase" == write ]]; then
      adb_args+=(put secure immersive_mode_confirmations confirmed)
    else
      adb_args+=(get secure immersive_mode_confirmations)
    fi
    if value=$(adb "${adb_args[@]}" 2>&1); then
      status=0
    else
      status=$?
    fi
    printf 'Display preparation %s: adb' "$phase"
    printf ' %s' "${adb_args[@]}"
    printf ' (exit %s):\n%s\n' "$status" "$value"
    if [[ "$status" != 0 ]]; then
      printf 'Display preparation failed during %s\n' "$phase" >&2
      return "$status"
    fi
    value=${value//$'\r'/}
    if [[ "$phase" == before && "$value" == confirmed ]]; then
      echo 'Immersive mode tutorial is already confirmed'
      return 0
    fi
    if [[ "$phase" == after && "$value" != confirmed ]]; then
      printf 'Expected immersive_mode_confirmations=<confirmed>, found <%s>\n' "$value" >&2
      return 1
    fi
  done
  echo 'Verified immersive mode tutorial confirmation'
}

preflight 2>&1 | tee "$diagnostics/preflight.txt"
adb logcat -c
prepare_display 2>&1 | tee -a "$diagnostics/preflight.txt"
bash ./gradlew connectedDebugAndroidTest --stacktrace
