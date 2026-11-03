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
  local copy_status
  trap - EXIT
  adb logcat -d -v threadtime > "$diagnostics/device-logcat.txt" 2>&1 || true
  if [[ -d build/outputs/androidTest-results/connected ]]; then
    cp -a build/outputs/androidTest-results/connected/. "$results/" || {
      copy_status=$?; if [[ "$status" == 0 ]]; then status=$copy_status; fi
    }
  fi
  if [[ -d build/reports/androidTests/connected ]]; then
    cp -a build/reports/androidTests/connected/. "$reports/" || {
      copy_status=$?; if [[ "$status" == 0 ]]; then status=$copy_status; fi
    }
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

read_device_value() {
  local status
  if device_value=$(adb "$@" 2>&1); then status=0; else status=$?; fi
  printf 'adb'
  printf ' %s' "$@"
  printf ' (exit %s):\n%s\n' "$status" "$device_value"
  if [[ "$status" != 0 ]]; then return "$status"; fi
  device_value=${device_value//$'\r'/}
}

verify_environment() {
  local expected_abi feature leanback=false
  if [[ "$version" == 34 ]]; then expected_abi=x86; else expected_abi=x86_64; fi
  read_device_value shell getprop ro.product.cpu.abi || return "$?"
  if [[ "$device_value" != "$expected_abi" ]]; then
    printf 'Expected ABI %s, found <%s>\n' "$expected_abi" "$device_value" >&2
    return 1
  fi
  read_device_value shell pm list features || return "$?"
  while IFS= read -r feature; do
    case "$feature" in
      feature:android.software.leanback|feature:android.software.leanback=*) leanback=true ;;
    esac
  done <<< "$device_value"
  if [[ "$version" == 34 ]]; then
    if [[ "$leanback" != true ]]; then
      echo 'API 34 TV image requires android.software.leanback' >&2
      return 1
    fi
    echo 'Verified Android TV API 34, ABI x86, Leanback feature'
  else
    if [[ "$leanback" == true ]]; then
      echo 'API 37.2 phone image must not advertise Leanback' >&2
      return 1
    fi
    read_device_value shell getconf PAGE_SIZE || return "$?"
    if [[ "$device_value" != 16384 ]]; then
      printf 'Expected 16 KB pages (16384), found <%s>\n' "$device_value" >&2
      return 1
    fi
    echo 'Verified phone API 37.2, ABI x86_64, 16 KB pages'
  fi
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
verify_environment 2>&1 | tee -a "$diagnostics/preflight.txt"
engine_diagnostics=${BATTLECITY_ENGINE_DIAGNOSTICS:-false}
case "$engine_diagnostics" in
  true|false) ;;
  *) echo 'BATTLECITY_ENGINE_DIAGNOSTICS must be true or false' | tee -a "$diagnostics/preflight.txt" >&2; exit 2 ;;
esac
printf 'Engine diagnostics requested: %s\n' "$engine_diagnostics" | tee -a "$diagnostics/preflight.txt"
tv_vbo_mode=${BATTLECITY_TV_VBO_MODE:-default}
case "$tv_vbo_mode" in
  default|disabled) ;;
  *) echo 'BATTLECITY_TV_VBO_MODE must be default or disabled' | tee -a "$diagnostics/preflight.txt" >&2; exit 2 ;;
esac
vbo_mode=default
if [[ "$version" == 34 ]]; then vbo_mode=$tv_vbo_mode; fi
printf 'Render mode requested: %s\n' "$vbo_mode" | tee -a "$diagnostics/preflight.txt"
adb logcat -c
if [[ "$version" == 37.2 ]]; then
  prepare_display 2>&1 | tee -a "$diagnostics/preflight.txt"
fi
bash ./gradlew connectedDebugAndroidTest --stacktrace \
  "-Pandroid.testInstrumentationRunnerArguments.battlecityEngineDiagnostics=$engine_diagnostics" \
  "-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=$vbo_mode"
