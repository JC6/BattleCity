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
python3 "$tree/scripts/build/file2str.py" "$repo/runtime/menu-regular.bdc" "$tree/src/emu/battlecity-menu-font.h" battlecity_menu_font uint8_t
# Rebuild the patched files from the pinned tree. Later patches deliberately
# touch earlier hunks, so reverse-checking each patch separately is ambiguous.
(
    patches=(
        menu-font rewind save web-audio web-video menu-input rewind-scheduler
        direct-rewind web-clock nes-palette slot-preview picture menu-viewport
        tv-startup tv-gamepads rewind-boundary
    )
    if [[ $platform == android ]]; then patches+=(tv-render tv-surface tv-native tv-compositor tv-stages); fi
    for i in "${!patches[@]}"; do patches[i]="$repo/runtime/${patches[i]}.patch"; done
    mapfile -t files < <(sed -n 's|^--- a/||p' "${patches[@]}" | sort -u)
    stage=$(mktemp -d)
    trap 'rm -rf -- "$stage"' EXIT
    git -C "$tree" archive "$revision" -- "${files[@]}" | tar -x -C "$stage"
    for patch in "${patches[@]}"; do git -C "$stage" apply --no-index "$patch"; done
    for file in "${files[@]}"; do
        if ! cmp -s "$stage/$file" "$tree/$file"; then cp "$stage/$file" "$tree/$file"; fi
    done
)
if ! cmp -s "$repo/runtime/wallpaper-previews.h" "$tree/src/frontend/mame/ui/wallpaper-previews.h"; then
    cp "$repo/runtime/wallpaper-previews.h" "$tree/src/frontend/mame/ui/wallpaper-previews.h"
fi
cp "$repo/runtime/screen-preview.h" "$tree/src/frontend/mame/ui/screen-preview.h"
cp "$repo/runtime/staff-roll.inc" "$tree/src/frontend/mame/ui/staff-roll.inc"
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
    cp "$repo/runtime/tv-gpu-raster.h" "$tree/src/emu/tv-gpu-raster.h"
    cp "$repo/runtime/tv-capture.h" "$tree/src/emu/tv-capture.h"
    cp "$repo/runtime/tv-surface-queue.h" "$tree/src/emu/tv-surface-queue.h"
    cp "$repo/runtime/tv-native-window.h" "$tree/src/emu/tv-native-window.h"
    if ! cmp -s "$repo/runtime/tv-profile.h" "$tree/src/emu/tv-profile.h"; then
        cp "$repo/runtime/tv-profile.h" "$tree/src/emu/tv-profile.h"
    fi
    make -C "$tree" "$target" "SDL_INSTALL_ROOT=$SDL_INSTALL_ROOT" "${flags[@]}"
    libs="$tree/android-project/app/src/main/libs/$abi"
    cp "$SDL_INSTALL_ROOT/lib/libSDL3.so" "$libs/"
    cp "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$triple/libc++_shared.so" "$libs/"
    "${GRADLE_BIN:-gradle}" -p "$repo/runtime/android" --project-cache-dir "$repo/runtime/android/.gradle/$abi" \
        -PruntimeAbi="$abi" -PmameTree="$tree" -Pcartridge="$rom" assembleDebug assembleCandidate
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
    cp "$repo/LICENSE" "$repo/runtime/cartridge/NOTICE" "$repo/runtime/Menu-Font-LICENSE.txt" "$out/site/licenses/"
    cp "$tree/battlecity.js" "$tree/battlecity.wasm" "$repo/runtime/android/src/main/res/drawable-nodpi/"battle_{surround,stars,symbols}.jpg "$out/site/"
    cartridge_hash=$(sha256sum < "$rom")
    predecessor=$(awk -v current="${cartridge_hash%% *}" '$1 == current {print $2}' "$repo/runtime/cartridge/save-compatibility.tsv")
    sed -e "s/@SAVE_PREDECESSOR@/$predecessor/g" -e "s/@CARTRIDGE_SHA256@/${cartridge_hash%% *}/g" "$repo/runtime/browser/index.html" > "$out/site/index.html"
    (cd "$out/site" && python3 -m zipfile -c "$out/battlecity-web.zip" index.html battlecity.js battlecity.wasm battle_{surround,stars,symbols}.jpg licenses)
fi
