#!/usr/bin/env bash
# Boot an API 34 television on a Linux host with KVM and exercise the installed game.
set -euo pipefail
apk=${1:?expected television APK}
labels=${2:?expected cartridge labels}
results=${3:?expected result directory}
sdk=${ANDROID_HOME:?Android SDK required}
sdk_tools="$sdk/cmdline-tools/latest/bin"
export ADB="$sdk/platform-tools/adb"
export ANDROID_SERIAL=emulator-5554
mkdir -p "$results"
exec > >(tee "$results/device.log") 2>&1
profile=$(mktemp -d "${TMPDIR:-/tmp}/battlecity-tv.XXXXXXXX")
export ANDROID_USER_HOME="$profile" ANDROID_EMULATOR_HOME="$profile" ANDROID_AVD_HOME="$profile/avd"
mkdir -p "$ANDROID_AVD_HOME"
emulator_pid=
cleanup() {
    if [[ -n $emulator_pid ]]; then
        kill "$emulator_pid" 2>/dev/null || true
        wait "$emulator_pid" 2>/dev/null || true
    fi
    rm -rf -- "$profile"
}
trap cleanup EXIT
image='system-images;android-34;android-tv;x86'
"$sdk_tools/sdkmanager" platform-tools emulator "$image"
echo no | "$sdk_tools/avdmanager" create avd -n BattleCity -k "$image" -d tv_1080p --path "$ANDROID_AVD_HOME/BattleCity.avd"
"$ADB" start-server
if "$ADB" devices | awk -v serial="$ANDROID_SERIAL" '$1==serial {found=1} END {exit !found}'; then
    echo "The test port is already in use by $ANDROID_SERIAL" >&2
    exit 1
fi
"$sdk/emulator/emulator" -avd BattleCity -port 5554 -accel on \
    -no-window -no-snapshot -no-boot-anim -gpu swiftshader >"$results/emulator.log" 2>&1 &
emulator_pid=$!
deadline=$((SECONDS+360))
until [[ "$(timeout 5 "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    if ! kill -0 "$emulator_pid" 2>/dev/null || (( SECONDS >= deadline )); then
        tail -50 "$results/emulator.log"
        exit 1
    fi
    sleep 2
done
python3 "$(dirname "$0")/television.py" "$apk" "$labels" "$results" "${@:4}"
