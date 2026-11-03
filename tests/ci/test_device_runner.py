"""Verify report isolation and failure propagation without starting a device."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "tools/run-android-device-tests.sh"
WORKFLOW = SCRIPT.parents[1] / ".github/workflows/android.yml"


class DeviceRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binary = self.root / "bin"
        binary.mkdir()
        adb = binary / "adb"
        adb.write_text("""#!/usr/bin/env bash
test "$ANDROID_SERIAL" = emulator-5554 || exit 98
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "${FAKE_ENV_FAIL_COMMAND:-none}" ]]; then
  echo 'fixture environment stdout'
  echo 'fixture environment stderr' >&2
  exit "$FAKE_ADB_EXIT"
fi
if [[ "${3:-}" == "$FAKE_FAIL_PROPERTY" ]]; then
  echo 'fixture property read failed' >&2
  exit "$FAKE_ADB_EXIT"
fi
setting_failure() {
  if [[ "$FAKE_SETTINGS_FAIL_PHASE" == "$1" ]]; then
    echo "fixture settings $1 stdout"
    echo "fixture settings $1 stderr" >&2
    exit "$FAKE_SETTINGS_EXIT"
  fi
}
case "$*" in
  'shell getprop ro.build.version.sdk') printf '%s%s\\n' "$FAKE_API" "$FAKE_CR" ;;
  'shell getprop ro.build.version.sdk_full') printf '%s%s\\n' "$FAKE_FULL" "$FAKE_CR" ;;
  'shell getprop ro.build.version.sdk_minor') printf '%s%s\\n' "$FAKE_MINOR" "$FAKE_CR" ;;
  'shell getprop ro.product.cpu.abi')
    if [[ "$FAKE_API" == 34 ]]; then abi=x86; else abi=x86_64; fi
    printf '%s%s\\n' "${FAKE_ABI-$abi}" "$FAKE_CR" ;;
  'shell pm list features')
    if [[ "$FAKE_API" == 34 ]]; then features=feature:android.software.leanback; else features=feature:android.software.activities; fi
    printf '%s%s\\n' "${FAKE_FEATURES-$features}" "$FAKE_CR" ;;
  'shell getconf PAGE_SIZE') printf '%s%s\\n' "${FAKE_PAGE_SIZE-16384}" "$FAKE_CR" ;;
  'shell settings --user current get secure immersive_mode_confirmations')
    if [[ -f "$SETTING_STATE" ]]; then
      setting_failure after
      printf '%s%s\\n' "$FAKE_SETTING_READBACK" "$FAKE_CR"
    else
      setting_failure before
      printf '%s%s\\n' "$FAKE_SETTING_INITIAL" "$FAKE_CR"
    fi ;;
  'shell settings --user current put secure immersive_mode_confirmations confirmed')
    setting_failure write
    printf confirmed > "$SETTING_STATE" ;;
  'shell dumpsys window windows')
    if [[ "$FAKE_WINDOW_EXIT" != 0 ]]; then
      echo 'fixture window dump failed' >&2
      exit "$FAKE_WINDOW_EXIT"
    fi
    echo 'mCurrentFocus=Window{fixture.focus}' ;;
  'logcat -d -v threadtime') echo 'simulated emulator log' ;;
  'logcat -c') ;;
  *) exit 99 ;;
esac
""")
        adb.chmod(0o755)
        (self.root / "gradlew").write_text("""#!/usr/bin/env bash
set -eu
test "$ANDROID_SERIAL" = emulator-5554
if [[ "$FAKE_API" != 34 ]]; then
  test "$FAKE_SETTING_INITIAL" = confirmed || test "$(cat "$SETTING_STATE")" = confirmed
fi
echo gradle >> "$COMMAND_LOG"
printf '%s\\n' "$@" > "$GRADLE_ARGUMENTS"
test ! -f build/outputs/androidTest-results/connected/TEST-stale.xml
mkdir -p build/outputs/androidTest-results/connected
echo '<testsuite tests="1"><testcase name="fresh"/></testsuite>' > build/outputs/androidTest-results/connected/TEST-new.xml
exit "$FAKE_EXIT"
""")
        self.commands = self.root / "commands.txt"
        self.arguments = self.root / "gradle-arguments.txt"
        self.setting = self.root / "immersive-setting.txt"
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        EMULATOR_PORT="5554", FAKE_API="34", FAKE_MINOR="0", FAKE_FULL="",
                        FAKE_FAIL_PROPERTY="none", FAKE_ADB_EXIT="17", FAKE_CR="", FAKE_EXIT="0",
                        COMMAND_LOG=str(self.commands), SETTING_STATE=str(self.setting),
                        GRADLE_ARGUMENTS=str(self.arguments),
                        FAKE_SETTING_INITIAL="null", FAKE_SETTING_READBACK="confirmed",
                        FAKE_SETTINGS_FAIL_PHASE="none", FAKE_SETTINGS_EXIT="23", FAKE_WINDOW_EXIT="0")

    def stale(self, relative):
        path = self.root / relative / "TEST-stale.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stale report")
        return path

    def test_diagnostics_argument_defaults_off_and_can_be_enabled(self):
        for requested in (None, "true", "false"):
            with self.subTest(requested=requested):
                self.env.pop("BATTLECITY_ENGINE_DIAGNOSTICS", None)
                if requested is not None:
                    self.env["BATTLECITY_ENGINE_DIAGNOSTICS"] = requested
                run = self.run_script("34")
                self.assertEqual(0, run.returncode, run.stdout + run.stderr)
                value = requested or "false"
                self.assertIn(
                    "-Pandroid.testInstrumentationRunnerArguments.battlecityEngineDiagnostics=" + value,
                    self.arguments.read_text().splitlines())
                self.assertIn("Engine diagnostics requested: " + value,
                              (self.root / "build/diagnostics/api-34/preflight.txt").read_text())

    def test_tv_vbo_mode_defaults_and_explicit_values_reach_instrumentation(self):
        for requested in (None, "default", "disabled"):
            with self.subTest(requested=requested):
                self.env.pop("BATTLECITY_TV_VBO_MODE", None)
                if requested is not None:
                    self.env["BATTLECITY_TV_VBO_MODE"] = requested
                run = self.run_script("34")
                self.assertEqual(0, run.returncode, run.stderr)
                mode = requested or "default"
                self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=" + mode,
                              self.arguments.read_text().splitlines())
                self.assertIn("Render mode requested: " + mode,
                              (self.root / "build/diagnostics/api-34/preflight.txt").read_text())

    def test_phone_remains_default_during_tv_vbo_experiment(self):
        self.use_phone()
        self.env["BATTLECITY_TV_VBO_MODE"] = "disabled"
        run = self.run_script("37.2")
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=default",
                      self.arguments.read_text().splitlines())

    def test_invalid_tv_vbo_mode_stops_before_gradle_and_keeps_diagnostics(self):
        self.env["BATTLECITY_TV_VBO_MODE"] = "yes"
        run = self.run_script("34")
        self.assertEqual(2, run.returncode)
        self.assertNotIn("gradle", self.commands.read_text().splitlines())
        diagnostic = self.root / "build/diagnostics/api-34"
        self.assertIn("must be default or disabled", (diagnostic / "preflight.txt").read_text())
        self.assertTrue((diagnostic / "window-state.txt").exists())

    def test_disabled_vbo_run_preserves_instrumentation_failure(self):
        self.env.update(BATTLECITY_TV_VBO_MODE="disabled", FAKE_EXIT="7")
        run = self.run_script("34")
        self.assertEqual(7, run.returncode)
        log = (self.root / "build/diagnostics/api-34/preflight.txt").read_text()
        self.assertIn("Render mode requested: disabled", log)
        self.assertIn("Runner exit status: 7", log)

    def test_invalid_diagnostics_setting_fails_without_running_gradle(self):
        self.env["BATTLECITY_ENGINE_DIAGNOSTICS"] = "yes"
        run = self.run_script("34")
        self.assertEqual(2, run.returncode)
        self.assertNotIn("gradle", self.commands.read_text().splitlines())
        diagnostic = self.root / "build/diagnostics/api-34"
        self.assertIn("must be true or false", (diagnostic / "preflight.txt").read_text())
        self.assertIn("Runner exit status: 2", (diagnostic / "preflight.txt").read_text())
        self.assertTrue((diagnostic / "window-state.txt").exists())

    def run_script(self, version):
        return subprocess.run(["bash", str(SCRIPT), version], cwd=self.root, env=self.env,
                              text=True, capture_output=True, timeout=10)

    def use_phone(self):
        self.env.update(FAKE_API="37", FAKE_FULL="37.2")

    def test_tv_requires_leanback_and_leaves_phone_settings_untouched(self):
        self.env["FAKE_SETTINGS_FAIL_PHASE"] = "write"
        run = self.run_script("34")
        self.assertEqual(0, run.returncode, run.stderr)
        commands = self.commands.read_text()
        self.assertIn("adb shell pm list features", commands)
        self.assertNotIn("shell settings", commands)
        self.assertFalse(self.setting.exists())
        self.assertIn("Verified Android TV API 34, ABI x86, Leanback feature",
                      (self.root / "build/diagnostics/api-34/preflight.txt").read_text())

    def test_wrong_abi_cannot_run_tests_or_reuse_old_reports(self):
        for version, abi in (("34", "x86_64"), ("34", "armeabi-v7a"),
                             ("37.2", "x86"), ("37.2", "arm64-v8a")):
            with self.subTest(version=version, abi=abi):
                stale = self.stale(f"build/outputs/androidTest-results/api-{version}")
                self.env.update(FAKE_API=version.split(".")[0], FAKE_FULL=version, FAKE_ABI=abi)
                self.assertEqual(1, self.run_script(version).returncode)
                self.assertFalse(stale.exists())
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                log = (self.root / f"build/diagnostics/api-{version}/preflight.txt").read_text()
                self.assertIn("Expected ABI", log)
                self.assertIn("Runner exit status: 1", log)

    def test_phone_and_tv_images_cannot_replace_each_other(self):
        for version, features in (("34", ""), ("34", "feature:android.software.leanback_only"),
                                  ("34", "feature:android.software.activities"),
                                  ("37.2", "feature:android.software.leanback")):
            with self.subTest(version=version, features=features):
                stale = self.stale(f"build/outputs/androidTest-results/api-{version}")
                self.env.update(FAKE_API=version.split(".")[0], FAKE_FULL=version,
                                FAKE_FEATURES=features)
                self.assertEqual(1, self.run_script(version).returncode)
                self.assertFalse(stale.exists())
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                log = (self.root / f"build/diagnostics/api-{version}/preflight.txt").read_text()
                self.assertIn("Leanback" if version == "37.2" else "leanback", log)

    def test_tv_accepts_a_versioned_leanback_feature(self):
        self.env.update(FAKE_FEATURES="feature:android.software.activities\r\nfeature:android.software.leanback=1\r")
        run = self.run_script("34")
        self.assertEqual(0, run.returncode, run.stderr)

    def test_phone_requires_real_16_kb_pages(self):
        self.use_phone()
        for page_size in ("4096", "65536", "", "garbage"):
            with self.subTest(page_size=page_size):
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env["FAKE_PAGE_SIZE"] = page_size
                self.assertEqual(1, self.run_script("37.2").returncode)
                self.assertFalse(stale.exists())
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn("Expected 16 KB pages (16384)", log)

    def test_environment_read_failures_preserve_output_and_original_status(self):
        for version, command in (("34", "shell getprop ro.product.cpu.abi"),
                                 ("34", "shell pm list features"),
                                 ("37.2", "shell getprop ro.product.cpu.abi"),
                                 ("37.2", "shell pm list features"),
                                 ("37.2", "shell getconf PAGE_SIZE")):
            with self.subTest(version=version, command=command):
                stale = self.stale(f"build/outputs/androidTest-results/api-{version}")
                self.env.update(FAKE_API=version.split(".")[0], FAKE_FULL=version,
                                FAKE_ENV_FAIL_COMMAND=command)
                self.assertEqual(17, self.run_script(version).returncode)
                self.assertFalse(stale.exists())
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                diagnostic = self.root / f"build/diagnostics/api-{version}"
                log = (diagnostic / "preflight.txt").read_text()
                for expected in (f"adb {command} (exit 17)", "fixture environment stdout",
                                 "fixture environment stderr", "Runner exit status: 17"):
                    self.assertIn(expected, log)
                self.assertTrue((diagnostic / "device-logcat.txt").exists())
                self.assertTrue((diagnostic / "window-state.txt").exists())

    def test_result_copy_failure_does_not_replace_the_original_test_failure(self):
        copy = self.root / "bin/cp"
        copy.write_text("#!/usr/bin/env bash\nexit 23\n")
        copy.chmod(0o755)
        for test_status, expected in (("7", 7), ("0", 23)):
            with self.subTest(test_status=test_status):
                self.env["FAKE_EXIT"] = test_status
                self.assertEqual(expected, self.run_script("34").returncode)
                log = (self.root / "build/diagnostics/api-34/preflight.txt").read_text()
                self.assertIn(f"Runner exit status: {expected}", log)

    def test_success_replaces_stale_results_and_preserves_other_platform(self):
        self.stale("build/outputs/androidTest-results/connected")
        stale = self.stale("build/outputs/androidTest-results/api-34")
        other = self.stale("build/outputs/androidTest-results/api-37.2")
        startup = self.root / "build/diagnostics/emulator-api-34/startup-logcat.txt"
        startup.parent.mkdir(parents=True)
        startup.write_text("log captured before the test script started")
        window = self.root / "build/diagnostics/api-34/window-state.txt"
        window.parent.mkdir(parents=True)
        window.write_text("stale window dump")
        run = self.run_script("34")
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertFalse(stale.exists())
        self.assertTrue(other.exists())
        self.assertTrue((stale.parent / "TEST-new.xml").exists())
        self.assertEqual("log captured before the test script started", startup.read_text())
        self.assertFalse(window.exists())

    def test_failed_test_command_preserves_failure_and_diagnostics(self):
        self.env.update(FAKE_API="37", FAKE_FULL="37.2", FAKE_MINOR="", FAKE_EXIT="7")
        run = self.run_script("37.2")
        self.assertEqual(7, run.returncode, run.stderr)
        self.assertTrue((self.root / "build/outputs/androidTest-results/api-37.2/TEST-new.xml").exists())
        log = self.root / "build/diagnostics/api-37.2/device-logcat.txt"
        self.assertIn("simulated emulator log", log.read_text())
        self.assertIn("Runner exit status: 7", log.with_name("preflight.txt").read_text())
        self.assertIn("mCurrentFocus=Window{fixture.focus}", log.with_name("window-state.txt").read_text())

    def test_full_version_takes_precedence_and_legacy_minor_is_only_a_fallback(self):
        for full, minor in (("37.2", ""), ("37.2", "0"), ("", "2")):
            with self.subTest(full=full, minor=minor):
                self.env.update(FAKE_API="37", FAKE_FULL=full, FAKE_MINOR=minor)
                run = self.run_script("37.2")
                self.assertEqual(0, run.returncode, run.stderr)
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn("Verified API 37.2", log)
                source = "ro.build.version.sdk_full" if full else "legacy ro.build.version.sdk_minor"
                self.assertIn("Version source: " + source, log)
                self.assertTrue((self.root / "build/outputs/androidTest-results/api-37.2/TEST-new.xml").exists())

    def test_crlf_device_properties_are_accepted_and_logged(self):
        self.env.update(FAKE_API="37", FAKE_FULL="37.2", FAKE_CR="\r")
        run = self.run_script("37.2")
        self.assertEqual(0, run.returncode, run.stderr)
        log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_bytes()
        self.assertIn(b"37.2\r\n", log)

    def test_wrong_or_malformed_full_version_cannot_fall_back_to_minor(self):
        for full in ("37.0", "37.3", "garbage", "3700002", "37.2.0", "+37.2", " 37.2"):
            with self.subTest(full=full):
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env.update(FAKE_API="37", FAKE_FULL=full, FAKE_MINOR="2")
                self.assertEqual(1, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn(f"Expected SDK full 37.2, found sdk_full=<{full}>", log)
                self.assertIn("Runner exit status: 1", log)

    def test_property_read_failure_preserves_command_output_and_exit_status(self):
        for property in ("sdk", "sdk_full", "sdk_minor"):
            with self.subTest(property=property):
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env.update(FAKE_API="37", FAKE_FULL="37.2", FAKE_MINOR="2",
                                FAKE_FAIL_PROPERTY="ro.build.version." + property)
                self.assertEqual(17, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn(f"adb shell getprop ro.build.version.{property} (exit 17):", log)
                self.assertIn("fixture property read failed", log)
                self.assertIn("Version preflight failed", log)
                self.assertIn("Runner exit status: 17", log)
                self.assertIn("simulated emulator log",
                              (self.root / "build/diagnostics/api-37.2/device-logcat.txt").read_text())

    def test_wrong_major_or_minor_version_cannot_reuse_old_reports(self):
        for api, full, minor in (("34", "37.2", "2"), ("37", "", "0"), ("37", "", "")):
            with self.subTest(api=api, full=full, minor=minor):
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env.update(FAKE_API=api, FAKE_FULL=full, FAKE_MINOR=minor)
                self.assertNotEqual(0, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))
                self.assertIn("Expected", (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text())

    def test_display_preparation_is_verified_before_gradle_on_phone(self):
        self.use_phone()
        get = "adb shell settings --user current get secure immersive_mode_confirmations"
        put = "adb shell settings --user current put secure immersive_mode_confirmations confirmed"
        for initial in ("null", "", "unexpected"):
            with self.subTest(initial=initial):
                self.setting.unlink(missing_ok=True)
                self.commands.unlink(missing_ok=True)
                self.env["FAKE_SETTING_INITIAL"] = initial
                run = self.run_script("37.2")
                self.assertEqual(0, run.returncode, run.stderr)
                self.assertEqual("confirmed", self.setting.read_text())
                commands = self.commands.read_text().splitlines()
                self.assertEqual([get, put, get], [c for c in commands if " shell settings " in c])
                self.assertLess(commands.index("adb logcat -c"), commands.index(get))
                self.assertLess(commands.index(put) + 1, commands.index("gradle"))
                self.assertEqual(get, commands[commands.index("gradle") - 1])
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn(f"{get} (exit 0):\n{initial}\n", log)
                self.assertIn("Verified immersive mode tutorial confirmation", log)
                self.assertIn("Runner exit status: 0", log)

    def test_display_confirmation_is_idempotent_and_skips_an_unnecessary_write(self):
        self.use_phone()
        for initial in ("confirmed", "null"):
            with self.subTest(initial=initial):
                self.setting.unlink(missing_ok=True)
                self.commands.unlink(missing_ok=True)
                self.env["FAKE_SETTING_INITIAL"] = initial
                for _ in range(2):
                    run = self.run_script("37.2")
                    self.assertEqual(0, run.returncode, run.stderr)
                commands = self.commands.read_text().splitlines()
                writes = [c for c in commands if " put secure immersive_mode_confirmations " in c]
                self.assertEqual(0 if initial == "confirmed" else 1, len(writes))
                self.assertEqual(2, commands.count("gradle"))
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn("Immersive mode tutorial is already confirmed", log)

    def test_settings_command_failure_stops_tests_and_preserves_diagnostics(self):
        self.use_phone()
        for phase in ("before", "write", "after"):
            with self.subTest(phase=phase):
                self.setting.unlink(missing_ok=True)
                self.commands.unlink(missing_ok=True)
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.stale("build/outputs/androidTest-results/connected")
                self.env["FAKE_SETTINGS_FAIL_PHASE"] = phase
                self.assertEqual(23, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                diagnostic = self.root / "build/diagnostics/api-37.2"
                log = (diagnostic / "preflight.txt").read_text()
                self.assertIn(f"Display preparation {phase}:", log)
                self.assertIn("(exit 23):", log)
                self.assertIn(f"fixture settings {phase} stdout", log)
                self.assertIn(f"fixture settings {phase} stderr", log)
                self.assertIn(f"Display preparation failed during {phase}", log)
                self.assertIn("Runner exit status: 23", log)
                self.assertIn("simulated emulator log", (diagnostic / "device-logcat.txt").read_text())
                self.assertIn("mCurrentFocus=Window{fixture.focus}", (diagnostic / "window-state.txt").read_text())

    def test_successful_settings_write_requires_a_matching_readback(self):
        self.use_phone()
        for readback in ("null", "", "unconfirmed"):
            with self.subTest(readback=readback):
                self.setting.unlink(missing_ok=True)
                self.commands.unlink(missing_ok=True)
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env["FAKE_SETTING_READBACK"] = readback
                self.assertEqual(1, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                log = (self.root / "build/diagnostics/api-37.2/preflight.txt").read_text()
                self.assertIn(f"Expected immersive_mode_confirmations=<confirmed>, found <{readback}>", log)
                self.assertIn("Runner exit status: 1", log)

    def test_window_dump_failure_does_not_mask_preparation_or_test_failure(self):
        self.use_phone()
        for fault, expected in (("preparation", 23), ("gradle", 7)):
            with self.subTest(fault=fault):
                self.setting.unlink(missing_ok=True)
                self.env.update(FAKE_WINDOW_EXIT="19", FAKE_EXIT="7" if fault == "gradle" else "0",
                                FAKE_SETTINGS_FAIL_PHASE="write" if fault == "preparation" else "none")
                self.assertEqual(expected, self.run_script("37.2").returncode)
                diagnostic = self.root / "build/diagnostics/api-37.2"
                self.assertIn(f"Runner exit status: {expected}", (diagnostic / "preflight.txt").read_text())
                self.assertIn("fixture window dump failed", (diagnostic / "window-state.txt").read_text())
                self.assertIn("simulated emulator log", (diagnostic / "device-logcat.txt").read_text())


class KvmPreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Exercise the actual workflow script without accessing the host KVM device.
        self.node = self.root / "kvm"
        self.node.symlink_to("/dev/null")
        step = WORKFLOW.read_text().split("      - name: Enable emulator acceleration\n", 1)[1]
        step = step.split("      - name: API 34 TV framework smoke tests\n", 1)[0]
        self.script = textwrap.dedent(step.split("        run: |\n", 1)[1]).replace("/dev/kvm", str(self.node))
        binary = self.root / "bin"
        binary.mkdir()
        sudo = binary / "sudo"
        sudo.write_text("""#!/usr/bin/env bash
echo "sudo $*" >> "$COMMAND_LOG"
[[ "$*" == "chmod a+rw $FAKE_KVM_PATH" ]] || exit 99
if [[ "$FAKE_CHMOD_EXIT" != 0 ]]; then echo 'fixture chmod denied' >&2; fi
exit "$FAKE_CHMOD_EXIT"
""")
        sudo.chmod(0o755)
        python = binary / "python3"
        python.write_text("""#!/usr/bin/env bash
echo open >> "$COMMAND_LOG"
if [[ "$FAKE_OPEN_EXIT" != 0 ]]; then
  echo 'fixture KVM open denied' >&2
  exit "$FAKE_OPEN_EXIT"
fi
exec "$REAL_PYTHON" "$@"
""")
        python.chmod(0o755)
        self.commands = self.root / "commands.txt"
        self.diagnostics = self.root / "build/diagnostics/kvm/setup.txt"
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        COMMAND_LOG=str(self.commands), FAKE_KVM_PATH=str(self.node),
                        FAKE_CHMOD_EXIT="0", FAKE_OPEN_EXIT="0", REAL_PYTHON=sys.executable)

    def run_script(self):
        return subprocess.run(["bash", "-e", "-c", self.script], cwd=self.root, env=self.env,
                              text=True, capture_output=True, timeout=10)

    def test_success_corrects_permissions_before_opening_and_records_diagnostics(self):
        run = self.run_script()
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertEqual([f"sudo chmod a+rw {self.node}", "open"], self.commands.read_text().splitlines())
        log = self.diagnostics.read_text()
        self.assertIn("uid=", log)
        self.assertIn(str(self.node), log)
        self.assertIn("KVM device opened for read/write", log)

    def test_missing_device_fails_before_privileged_commands_and_keeps_diagnostics(self):
        self.node.unlink()
        run = self.run_script()
        self.assertNotEqual(0, run.returncode)
        self.assertFalse(self.commands.exists())
        self.assertIn(str(self.node), self.diagnostics.read_text())

    def test_regular_file_cannot_replace_the_kvm_character_device(self):
        self.node.unlink()
        self.node.write_text("not a device")
        run = self.run_script()
        self.assertNotEqual(0, run.returncode)
        self.assertFalse(self.commands.exists())
        self.assertIn("not a character device", self.diagnostics.read_text())

    def test_chmod_failure_is_not_hidden_by_tee_and_does_not_attempt_open(self):
        self.env["FAKE_CHMOD_EXIT"] = "7"
        run = self.run_script()
        self.assertEqual(7, run.returncode)
        self.assertEqual([f"sudo chmod a+rw {self.node}"], self.commands.read_text().splitlines())
        self.assertIn("fixture chmod denied", self.diagnostics.read_text())

    def test_open_failure_is_not_hidden_by_tee(self):
        self.env["FAKE_OPEN_EXIT"] = "13"
        run = self.run_script()
        self.assertEqual(13, run.returncode)
        self.assertEqual("open", self.commands.read_text().splitlines()[-1])
        self.assertIn("fixture KVM open denied", self.diagnostics.read_text())


if __name__ == "__main__":
    unittest.main()
