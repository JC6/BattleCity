#!/usr/bin/env bash
# Build only the NES/Famicom driver and package the homebrew game by default.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
platform=${1:?expected web or android}
out="$repo/build/mame-runtime/$platform"
revision=ce8812e6a1dcafc97fbafc6d48b0c8184984845f
tree="$out/mame"
case "$platform" in
    web)
        if [[ -z ${EMSDK:-} ]] && command -v emcc >/dev/null; then
            candidate=$(dirname "$(dirname "$(dirname "$(realpath "$(command -v emcc)")")")")
            if [[ -x "$candidate/upstream/emscripten/emcc" ]]; then export EMSDK="$candidate"; fi
        fi
        : "${EMSDK:?Activate the Emscripten SDK with source emsdk_env.sh before building}"
        [[ -x "$EMSDK/upstream/emscripten/emcc" ]] || { echo "Invalid EMSDK compiler path" >&2; exit 1; }
        export PATH="$EMSDK/upstream/emscripten:$PATH"
        command -v emmake >/dev/null
        command -v embuilder >/dev/null
        ;;
    android) : "${ANDROID_NDK_HOME:?Android NDK required}" "${SDL_INSTALL_ROOT:?Android SDL 3.4.12 installation required}" ;;
    *) echo "Expected web or android" >&2; exit 2 ;;
esac
mkdir -p "$out"
case "${2:-game}" in
    game) rom="$out/game.nes"; python3 "$repo/runtime/cartridge/build.py" "$rom" --labels "$out/game.lbl" ;;
    --probe) rom="$out/probe.nes"; python3 "$repo/tests/nes/probe.py" "$rom" ;;
    *) rom=$(realpath -e "$2") ;;
esac
if [[ ! -d "$tree/.git" ]]; then
    git init -q "$tree"
fi
if ! git -C "$tree" cat-file -e "$revision^{commit}" 2>/dev/null; then
    git -C "$tree" fetch --depth=1 https://github.com/mamedev/mame.git "$revision"
fi
git -C "$tree" checkout -q --detach "$revision"
# Align the definition with the upstream friend declarations for Clang.
if grep -qx 'struct State' "$tree/3rdparty/residfp/State.h"; then
    sed -i '/^struct State$/ { s/struct/class/; n; a public:
}' "$tree/3rdparty/residfp/State.h"
fi
for patch in "$repo/runtime/rewind.patch" "$repo/runtime/save.patch" "$repo/runtime/web-audio.patch" "$repo/runtime/web-video.patch" "$repo/runtime/menu-input.patch" "$repo/runtime/rewind-scheduler.patch" "$repo/runtime/direct-rewind.patch" "$repo/runtime/nes-palette.patch" "$repo/runtime/slot-preview.patch" "$repo/runtime/picture.patch" "$repo/runtime/menu-viewport.patch"; do
    if ! git -C "$tree" apply --reverse --check "$patch" 2>/dev/null; then
        git -C "$tree" apply "$patch"
    fi
done
if ! cmp -s "$repo/runtime/wallpaper-previews.h" "$tree/src/frontend/mame/ui/wallpaper-previews.h"; then
    cp "$repo/runtime/wallpaper-previews.h" "$tree/src/frontend/mame/ui/wallpaper-previews.h"
fi
if ! cmp -s "$repo/runtime/mainmenu.cpp" "$tree/src/frontend/mame/ui/mainmenu.cpp"; then
    cp "$repo/runtime/mainmenu.cpp" "$tree/src/frontend/mame/ui/mainmenu.cpp"
fi

flags=(TARGET=mame SUBTARGET=battlecity SOURCES=src/mame/nintendo/nes.cpp OSD=sdl3 -j"${BUILD_JOBS:-2}")
if [[ "$platform" == android ]]; then
    abi=${BATTLECITY_ANDROID_ABI:-arm64-v8a}
    case "$abi" in
        arm64-v8a) target=android-arm64; triple=aarch64-linux-android ;;
        x86) target=android-x86; triple=i686-linux-android; flags+=(NOASM=1) ;;
        *) echo "Unsupported Android ABI: $abi" >&2; exit 2 ;;
    esac
    make -C "$tree" "$target" "SDL_INSTALL_ROOT=$SDL_INSTALL_ROOT" "${flags[@]}"
    libs="$tree/android-project/app/src/main/libs/$abi"
    cp "$SDL_INSTALL_ROOT/lib/libSDL3.so" "$libs/"
    cp "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$triple/libc++_shared.so" "$libs/"
    "${GRADLE_BIN:-gradle}" -p "$repo/runtime/android" --project-cache-dir "$repo/runtime/android/.gradle/$abi" \
        -PruntimeAbi="$abi" -PmameTree="$tree" -Pcartridge="$rom" assembleDebug
else
    # The upstream generated link project resolves absolute asset paths.
    embuilder build sdl3 sdl3_ttf
    # GENie embeds cartridge and pre-JS paths in the generated link recipe.
    # The upstream target does not track changes to those embedded files.
    rm -f "$tree/battlecity.html"
    emmake make -C "$tree" asmjs REGENIE=1 "${flags[@]}" \
        "LDOPTS=-sGROWABLE_ARRAYBUFFERS=0 --pre-js $repo/runtime/browser/storage.js -lidbfs.js --embed-file $rom@/game.nes --embed-file $repo/runtime/browser/keyboard.cfg@/keyboard.cfg"
    mkdir -p "$out/site/licenses/MAME"
    cp "$tree/COPYING" "$tree"/docs/legal/* "$out/site/licenses/MAME/"
    cp "$repo/LICENSE" "$repo/runtime/cartridge/NOTICE" "$out/site/licenses/"
    cp "$tree/battlecity.js" "$tree/battlecity.wasm" "$repo/runtime/android/src/main/res/drawable-nodpi/"battle_{surround,stars,symbols}.jpg "$out/site/"
    cartridge_hash=$(sha256sum < "$rom")
    sed "s/@CARTRIDGE_SHA256@/${cartridge_hash%% *}/g" "$repo/runtime/browser/index.html" > "$out/site/index.html"
    (cd "$out/site" && python3 -m zipfile -c "$out/battlecity-web.zip" index.html battlecity.js battlecity.wasm battle_{surround,stars,symbols}.jpg licenses)
fi
