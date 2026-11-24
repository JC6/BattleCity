# Battle City MAME runtime

The target is the English Battle City game in Nintendo Switch NAMCO MUSEUM ARCHIVES Vol 2. This runtime builds a Nintendo Entertainment System subtarget from MAME commit `ce8812e6a1dcafc97fbafc6d48b0c8184984845f`. The default build runs the playable game in `runtime/cartridge/`. Both platforms build the same iNES file. See the [game controls, reference comparison and acceptance results](cartridge/README.md).

The upstream GitHub counts checked on 2026-11-23 were 10,738 for MAME, 2,714 for cc65, 17,054 for SDL and 27,793 for Emscripten. Gradle had 18,941, Playwright had 100,823 and FFmpeg had 67,987. FFmpeg is used for the independent Switch screenshot comparison. [MAME](https://github.com/mamedev/mame) · [cc65](https://github.com/cc65/cc65) · [SDL](https://github.com/libsdl-org/SDL) · [Emscripten](https://github.com/emscripten-core/emscripten) · [Gradle](https://github.com/gradle/gradle) · [Playwright](https://github.com/microsoft/playwright) · [FFmpeg](https://github.com/FFmpeg/FFmpeg)

## Replay check

The following command exercises the separate controller and audio diagnostic on Linux with MAME 0.285 installed.

```sh
SDL_VIDEODRIVER=dummy python3 tests/nes/probe.py /tmp/controller-test.nes --mame /usr/games/mame
```

The cartridge reads both controller ports and programs the pulse channel with four distinct frequencies. The test compares each entire 256×240 frame for 120 frames after an in-process load, then repeats in a fresh emulator process using the on-disk state. After each replay, the harness restores the checkpoint again, changes the second controller input and checks that the cartridge receives the new input and displays a different picture. It checks each controller independently, measures four PCM tones and checks that the final tone follows the new second-player input. For this cartridge, restoring a checkpoint three frames before the presentation target lets MAME regenerate the video pipeline. The harness replays the neutral inputs used during those three frames.

## Target builds

Run from the repository root. Use a build path without spaces for MAME's upstream GNU Make build. Each command checks out the pinned revision into a separate platform build tree. An optional second argument names an iNES cartridge you are entitled to package. The manual **Battle City NES runtime** workflow defaults to the game and uploads the resulting APK or static files. Select `probe` in the workflow or pass `--probe` locally to run the diagnostic cartridge. Building the game requires Python 3 and the cc65 tools (`cc65`, `ca65` and `cl65`) on PATH.

```sh
bash tools/build-mame-runtime.sh web
bash tools/build-mame-runtime.sh android
```

Web requires an activated Emscripten 6.0.2 SDK and a native C++ build environment. Serve `build/mame-runtime/web/site/` over HTTP. Start activates the canvas and browser audio. Player 1 uses WASD, J and K. Player 2 uses arrows, N and M. Enter and right Shift map to Start and Select. The browser entry mounts IndexedDB-backed storage before starting the core.

Android requires JDK 17, Gradle 8.7, SDK platform 34, NDK r28c, and an ARM64 SDL 3.4.12 installation. Set `ANDROID_NDK_HOME` and `SDL_INSTALL_ROOT` to the NDK and SDL installation respectively. The SDL installation must provide headers, its shared library and sdl3.pc. The workflow shows how to extract these from the official SDL Android package. Gradle writes the APK under `runtime/android/build/outputs/apk/debug/`. The Leanback launcher packages the cartridge locally and keeps state and configuration under the application's private files directory.

## Acceptance

The native gameplay harness tests all 35 stage boundaries. The Web gameplay harness drives the release keyboard mappings through both controller ports. See the [acceptance record](cartridge/README.md) for the procedures and the limits of Switch and TV validation.


## Shared player menu

Esc on a keyboard or the left shoulder button on a gamepad opens the shared System Menu. Save and Load show four horizontal slots with the date and a screenshot of each saved game. Left and right select a slot. Delete on a keyboard or the west face button on a gamepad toggles overwrite protection for an occupied slot. Settings stores the screen size, anti-aliasing, scan lines and wallpaper. Screen Settings shows the same fixed shooter scene in all four modes. The regular-weight menu face is a bitmap subset generated from the pinned MAME documentation font. Its SIL license is included in both packages. Saving, resetting and returning to the Battle City title require confirmation. Backspace or the east face button returns to the preceding page. Staff Credits scrolls the original English collection credits, with Down for fast scrolling. R on the keyboard and the right shoulder button on a controller rewind directly. The core records a checkpoint every emulated second. The precise checkpoint interval used by the Switch release still needs a synchronized recording.

Save slots live under a directory named for the SHA-256 digest of the cartridge. Each slot is written to a temporary file before replacement. The browser flushes saves to IndexedDB and reports completion after the flush callback. Browser keyboard startup, changing NES pixels, independent controller tones, rewind and persistent save/load can be checked with the existing Web Playwright dependencies:

```sh
node tests/nes/browser.cjs http://127.0.0.1:8765/
```

## Diagnostic build results, 2026-11-21

| Artifact | SHA-256 |
| --- | --- |
| Web package built with `--probe` | `271510104a43ff9711f83ef45aded78369f268a3890106d3ceaec1c4de271734` |
| APK built with `--probe` | `583cb3d7b2e58ae771c4586b5f0ea8a9d8c41b72448cd975a4807af0977a890a` |
| Diagnostic cartridge | `bdb37899de7faaf640c43c46aff0a50a6173afa3348947d8a94b9a874bedc36a` |

Serve the extracted site or the build output and open its local address:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory build/mame-runtime/web/site
```

Chromium 153.0.8010.12 and WebKit 26.6 on Linux passed keyboard startup, changing NES pixels, four PCM pitches selected independently by the two players, menu rewind followed by new input, save, refresh and load. The browser test measures PCM at the Web Audio backend input and checks the audio context is running.

The 120-frame trace has SHA-256 `4c3f9d1aadba3e6c1501fa1c5063064360365a47d944936f40388639f90a83bd` on both the Linux MAME 0.285 reference and the pinned WebAssembly core. Chromium verified in-process and fresh-page restores against that trace. To repeat the trace test on the built site:

```sh
node tests/nes/browser-replay.cjs http://127.0.0.1:8000/
```

In a disposable Chromium profile, a simulated IndexedDB flush failure preserved the previous committed slot byte-for-byte after restart. An invalid in-memory slot header did not report a successful load, and the intact persistent slot loaded on restart.

The diagnostic APK passed v2 signature verification, cartridge digest verification and inspection of all three ARM64 libraries.

## Playable Android TV build

Connect both gamepads before launching a two-player session. The official Android TV API 34 image exercised the installed x86 build with two independent kernel gamepads. It passed cold start, individual movement and firing, shoulder rewind, slot protection, loading a paused game after process restart, and second-player reconnection. After returning from Home, the same process retained the paused field and both player positions. Screenshots confirmed battlefield pixels in the restored game and in the first save slot. The job archived screen captures and a one-second, 48 kHz PCM recording. Physical TV controller latency and speaker output still require measurement. [Device run and artifacts](https://github.com/JC6/BattleCity/actions/runs/45310454441)

## Measuring Android TV full frames

The TV release uses SDL's software renderer at the output resolution. The Android-only MAME setting `scalemode native-tv` selects an SDL renderer at startup and offers nearest-neighbour scaling of a native-size texture during gameplay. Menus, textured overlays, antialiasing and scanlines use the output resolution.

On a dedicated API 34 television emulator, run the following against the packaged x86 APK and the labels for its embedded cartridge.

```sh
bash tests/nes/television-avd.sh deliverable/tv-emulator.apk build/shared/game.lbl build/tv-result
```

The full run exercises two gamepads on both renderers, records three endings, and compares the renderers with the same controller edges. Use `--suite render` for the paired timing and six fixed display settings, or `--suite scenes` for the shield, treads, shots, tank explosion and headquarters. The harness verifies cartridge state before comparing the 256 × 224 visible pixel centres and the whole output raster.

The lightweight run creates an app-private measurement file, warms up for ten emulated seconds, and appends one JSON row per 30-second window. It counts vblanks, successful SDL texture-and-present submissions, and PCM frames handed to the first system sound sink. The system trace is taken after the third window, while the same process is in the foreground. The detailed `timing` suite records WAV and RAM separately. A compositor timestamp measures Android presentation. Physical input-to-display latency requires a device measurement.
