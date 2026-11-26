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

Android requires JDK 17, Gradle 8.7, SDK platform 34, NDK r28c, and an ARM64 SDL 3.4.12 installation. Set `ANDROID_NDK_HOME` and `SDL_INSTALL_ROOT` to the NDK and SDL installation respectively. The SDL installation must provide headers, its shared library and sdl3.pc. The workflow extracts headers from the official SDL Android package and builds the matching native library from the pinned SDL source with the pre-swap readback hook. Gradle writes the APK under `runtime/android/build/outputs/apk/debug/`. The Leanback launcher packages the cartridge locally and keeps state and configuration under the application's private files directory.

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

The Android build produces an SDL software baseline and an `egl-tv` candidate that draws into the existing SurfaceView and swaps once per game frame. `compositor-tv` selects the previous SurfaceControl child for a same-device comparison. All three paths share the cartridge, save directory and controller code. The acceptance workflow builds SDL 3.4.12 from its pinned source archive and applies the window readback hook in `runtime/tv-sdl-swap.patch`. This exposes the actual SDL window texture after the final draw for frozen-frame comparisons.

On a dedicated API 34 television emulator, run the following against the packaged x86 APK and the labels for its embedded cartridge.

```sh
mkdir -p build/tv-result
sha256sum deliverable/tv-emulator{,-candidate}.apk build/shared/game.nes > build/tv-result/tested-sha256.txt
bash tests/nes/television-avd.sh deliverable/tv-emulator-candidate.apk build/shared/game.lbl build/tv-result \
  --stable deliverable/tv-emulator.apk --record-candidate-failure --suite controls --suite prototype --suite candidate-controls --suite held-out --suite timing
if PYTHONPATH=tests/nes python3 -c "import sys; from pathlib import Path; from tv_release_gate import preliminary; sys.exit(0 if all(preliminary(Path('build/tv-result'),'egl-tv').values()) else 1)"; then
  bash tests/nes/television-avd.sh deliverable/tv-emulator-candidate.apk build/shared/game.lbl build/tv-result --formal --suite render --suite scenes
  mkdir -p build/tv-result/second
  cp build/tv-result/tested-sha256.txt build/tv-result/second/
  bash tests/nes/television-avd.sh deliverable/tv-emulator-candidate.apk build/shared/game.lbl build/tv-result/second --formal --suite render --suite scenes
fi
python3 tests/nes/tv_release_gate.py --renderer egl-tv build/tv-result
```

The first boot records ordinary battle and explosion loads on SDL, SurfaceControl and EGL starting from identical cartridge states. Two gamepads exercise each APK. Three solo endings and the two filmed co-op outcomes are recorded on the default APK. The frozen cases include battle frames 626, 633 and 648, explosion frame 700, and colour bars with single-pixel lines. The harness checks the 2 KiB RAM marker, 256 × 224 pixel centres, wallpaper and the full system screenshot against a repeated baseline. It captures the source, expanded buffer, actual SDL or EGL readback immediately before swap and Android's layer geometry in the same scene.

The single-window EGL candidate uploads the native RGB565 raster into an integer texture. A shader uses MAME’s 16.16 coordinates and channel expansion to update a retained intermediate image. The final sampling pass uses a vertex buffer for the six quad corners. The final normalized linear sample is retained in a window-sized RGBA8 framebuffer. The renderer pads each changed rectangle by one texel, flips it into window coordinates and uses a same-size native blit on every frame. The measurement APK can hold a prepared frame, upload input independently, bypass the final sampler or request a different swap interval. Each profiling mode records sequential NES frame IDs and Android presentation evidence.

The candidate requires a one-to-one association between sequential NES frames and display timestamps. The probe checks native `EGL_DISPLAY_PRESENT_TIME_ANDROID` or a single SurfaceView's SurfaceFlinger `PRESENT_FENCE` events. Missing identifiers and incomplete time series are reported as unverified. If the probe and controls pass, two fresh AVDs each measure three 30-second windows and eight picture cases. Every window must meet the 99%–101% game and PCM limits. The previous release used by the save upgrade check is selected by `previous_tv_run`. [Perfetto graphics frame events](https://github.com/google/perfetto/blob/main/protos/perfetto/trace/android/graphics_frame_event.proto)

The lightweight run creates an app-private measurement file, warms up for ten emulated seconds, and appends one JSON row per 30-second window. It counts vblanks, successful window-buffer or SDL submissions, and PCM frames handed to the first system sound sink. The system trace is taken after the third window, while the same process is in the foreground. The detailed `timing` suite records WAV and RAM separately. A compositor timestamp measures Android presentation. Physical input-to-display latency requires a device measurement.

The previous SurfaceControl candidate rotates three full-size RGBA hardware buffers on an API 34 SurfaceControl layer. Each buffer accumulates damage until its next use. The producer waits for the replacing transaction to release that buffer and for its release fence before writing it. In an unfiltered game the NES uploads its native RGB565 raster to a GLES 3 integer texture. A shader uses MAME’s nearest-sample coordinates and channel expansion to draw directly into the three imported EGLImages. A native fence signals completion to SurfaceControl. Menus and filters use mapped buffer writes. The same CPU path takes over when a device cannot import or draw into these targets. The per-window measurements include buffer waiting, locking, rendering or copying, posting, GPU frame counts, frame ID discontinuities and the time to the compositor callback. A 30-second sample drains pending transactions before reporting submitted and completed frame IDs. On frozen frames the harness captures the Android screenshot, native raster, expanded RGB and the actual buffer before presentation. For the direct GPU path the diagnostic CPU expansion is independent of the readback of the imported hardware buffer. The same APK can force full redraws to compare them with retained-buffer updates on identical battle states. The profile reports native fence creation, flushing and descriptor export separately.

The TV default uses SDL software rendering. The test-only private file `tv-low-buffer` selects a scale of 1, 2, 3 or 4 times 256 × 240 for unfiltered game output. The geometry suite reads the actual EGL window size and compares four scenes at each scale and at the full layout size. On the 1080p API 34 x86 AVD, the full 1195 × 960 surface reproduced all four SDL system screenshots. All four smaller surfaces changed the displayed image.

The presentation-cost suite runs three matched 30-second trials of each workload in the same APK. The controls force a complete cached blit with either per-frame or batched log writes. The candidate queries the age of the EGL back buffer and repairs the union of the current and intervening changes. It reports the current frame's damage to the compositor when the driver accepts damage rectangles. Unknown buffer age, an expired history, surface restarts, state loading and full invalidations cause a complete copy. The stored cache includes the final linear sample. The isolated producer changes a visible eight-pixel square at every swap and restores the original image when the trial ends. Normal gameplay contains the original pixels. Each test window exports the frame IDs and its buffer, swap and display timestamps before closing. [EGL buffer age](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_buffer_age.txt) · [Swap with damage](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_swap_buffers_with_damage.txt)

The API 34 x86 TV driver advertised swap with damage but no buffer age. All 27 1195×960 windows therefore used complete copies. Across the three replicates, prepared-frame median display rates were 37.48, 37.47 and 37.37 frames/s for per-frame flushing, batched flushing and the capability-selected path. Normal battle reached 35.62, 35.60 and 35.58 frames/s, and explosion load reached 36.17, 36.02 and 35.97 frames/s. All 29,481 frame IDs matched system display timestamps. In the six capability-selected gameplay trials, neither the game nor PCM reached the 99% minimum. SDL remains the default. The system-image comparisons, swap readback and gamepad checks passed. The two promotion boots were skipped. The partial path still needs measurement on a driver that reports a usable buffer age. [Acceptance run](https://github.com/JC6/BattleCity/actions/runs/45761439730)

In the previous buffer-size experiment, with presentation bypassed, game and PCM reached 100.000% and 99.998% of real time. With emulation held still, the same full-size window displayed 1,061 prepared frames in 30.004 seconds (35.36 frames/s). Normal battle and explosion loads reached 55.49% and 57.12% of real time for the game and 55.23% and 56.66% for system PCM. SurfaceFlinger confirmed 1,001/1,001 and 1,030/1,030 frame IDs. SDL measured 44.65%–45.34%. The pixel comparisons ruled out the four smaller buffers. Full-size presentation alone missed the target frame rate, so the experiment stopped before adding a render thread. Both APKs passed the two-controller suite. ARM64 timing and physical output latency remain unmeasured. [Acceptance run](https://github.com/JC6/BattleCity/actions/runs/45744441858)

The measurement ZIP contains the original and registered menu frames, the eight sampling times, old and new screenshots at both resolutions, and repeat captures. Run `python3 methods/tv_slot_calibration.py RUN_DIRECTORY` from its extracted root to regenerate the 32 comparisons and their outline coordinates. Run `python3 methods/tv_presentation_cost.py RUN_DIRECTORY` to reconcile the 27 performance windows against their original frame maps and SurfaceFlinger traces.

Use `tests/nes/tv_stage_analysis.py` with the held-out output directory and a JSON destination to locate the first divergent stage. The release selector compares all output pixels against a repeated software screenshot. The standalone report links the tested packages to their hashes, both browser upgrade jobs and the TV installation and controller checks.

Web and Android keep save files in cartridge-specific directories. A pair of hashes in the save compatibility table permits copying slots, thumbnails and lock files to the new directory when upgrading. The terminal-tally correction reuses all 220 named cartridge addresses and preserves the previous program everywhere except the two-byte jump operand and 12 formerly unused bytes. Browser and Android have separate upgrade tests because they use different storage systems.
