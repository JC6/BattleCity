#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: run-android-device-tests.sh 34}
case "$version" in
  34) ;;
  *) echo "Unsupported test platform: $version" >&2; exit 2 ;;
esac
export ANDROID_SERIAL="emulator-${EMULATOR_PORT:?Run inside android-emulator-runner}"
results="build/outputs/androidTest-results/api-$version"
reports="build/reports/androidTests/api-$version"
diagnostics="build/diagnostics/api-$version"
rm -rf "$results" "$reports" "$diagnostics" \
  build/outputs/androidTest-results/connected build/reports/androidTests/connected
mkdir -p "$results" "$reports" "$diagnostics"
touch "$diagnostics/runner-started"

collect_results() {
  status=$?
  local copy_status logcat_status=0
  trap - EXIT
  adb logcat -d -v threadtime > "$diagnostics/device-logcat.txt" 2>&1 || logcat_status=$?
  printf 'Logcat exit status: %s\n' "$logcat_status" >> "$diagnostics/preflight.txt"
  adb shell dumpsys display > "$diagnostics/display-state.txt" 2>&1 || true
  {
    read_device_value shell wm density || true
    read_device_value shell cmd overlay lookup android android:integer/config_maxUiWidth || true
    read_device_value shell dumpsys window displays || true
  } > "$diagnostics/display-configuration.txt" 2>&1
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
  printf 'Requested API: %s\n' "$version"
  read_device_value shell getprop ro.build.version.sdk || return "$?"
  if [[ "$device_value" != "$version" ]]; then
    printf 'Expected API %s, found sdk=<%s>\n' "$version" "$device_value" >&2
    return 1
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
  local expected_abi=x86 feature leanback=false
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
  if [[ "$leanback" != true ]]; then
    echo "API $version TV image requires android.software.leanback" >&2
    return 1
  fi
  read_device_value shell wm size || return "$?"
  local physical='' override='' line physical_count=0 override_count=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^Physical\ size:\ ([0-9]+)x([0-9]+)$ ]]; then
      physical="${BASH_REMATCH[1]}x${BASH_REMATCH[2]}"
      physical_count=$((physical_count + 1))
    elif [[ "$line" =~ ^Override\ size:\ ([0-9]+)x([0-9]+)$ ]]; then
      override="${BASH_REMATCH[1]}x${BASH_REMATCH[2]}"
      override_count=$((override_count + 1))
    elif [[ "$line" == 'Physical size:'* || "$line" == 'Override size:'* ]]; then
      printf 'Malformed display size: %s\n' "$line" >&2
      return 1
    fi
  done <<< "$device_value"
  local expected_effective=1920x1080
  if [[ "$physical_count" != 1 || "$override_count" -gt 1 || "$physical" != 3840x2160 || "${override:-$physical}" != "$expected_effective" ]]; then
    printf 'Expected 4K physical display 3840x2160 and effective display %s, found physical=<%s>, override=<%s>\n' "$expected_effective" "$physical" "$override" >&2
    return 1
  fi
  printf 'Verified Android TV API %s, ABI %s, Leanback feature, 4K display 3840x2160, effective display %s\n' "$version" "$expected_abi" "$expected_effective"
}

preflight 2>&1 | tee "$diagnostics/preflight.txt"
verify_environment 2>&1 | tee -a "$diagnostics/preflight.txt"
read_device_value shell getprop ro.build.fingerprint > "$diagnostics/device-fingerprint.txt" || true
engine_diagnostics=${BATTLECITY_ENGINE_DIAGNOSTICS:-false}
case "$engine_diagnostics" in
  true|false) ;;
  *) echo 'BATTLECITY_ENGINE_DIAGNOSTICS must be true or false' | tee -a "$diagnostics/preflight.txt" >&2; exit 2 ;;
esac
printf 'Engine diagnostics requested: %s\n' "$engine_diagnostics" | tee -a "$diagnostics/preflight.txt"
vbo_mode=${BATTLECITY_TV_VBO_MODE:-default}
case "$vbo_mode" in
  default|disabled) ;;
  *) echo 'BATTLECITY_TV_VBO_MODE must be default or disabled' | tee -a "$diagnostics/preflight.txt" >&2; exit 2 ;;
esac
printf 'Render mode requested: %s\n' "$vbo_mode" | tee -a "$diagnostics/preflight.txt"
adb logcat -c
bash ./gradlew connectedDebugAndroidTest --stacktrace \
  "-Pandroid.testInstrumentationRunnerArguments.battlecityEngineDiagnostics=$engine_diagnostics" \
  "-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=$vbo_mode"
