"""Verify TV environment checks, report isolation and failures without starting a device."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "tools/run-android-device-tests.sh"
WORKFLOW = SCRIPT.parents[1] / ".github/workflows/android.yml"
PREPARE = SCRIPT.with_name("prepare-android-tv.sh")
APKS = ("build/outputs/apk/debug/BattleCity-debug.apk",
        "build/outputs/apk/androidTest/debug/BattleCity-debug-androidTest.apk")


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
if [[ "$*" == "$FAKE_ENV_FAIL_COMMAND" ]]; then
  echo 'fixture environment stdout'
  echo 'fixture environment stderr' >&2
  exit "$FAKE_ADB_EXIT"
fi
case "$*" in
  'shell getprop ro.build.version.sdk') printf '%s%s\\n' "$FAKE_API" "$FAKE_CR" ;;
  'shell getprop ro.product.cpu.abi')
    printf '%s%s\\n' "${FAKE_ABI-x86}" "$FAKE_CR" ;;
  'shell getprop ro.build.fingerprint') echo 'google/tv/tv:14/BUILD/1234:user/release-keys' ;;
  'shell pm list features') printf '%s%s\\n' "${FAKE_FEATURES-feature:android.software.leanback}" "$FAKE_CR" ;;
  'shell wm size')
    display=$'Physical size: 3840x2160\\nOverride size: 1920x1080'
    printf '%s%s\\n' "${FAKE_DISPLAY-$display}" "$FAKE_CR" ;;
  'shell wm density') echo 'Physical density: 640' ;;
  'shell cmd overlay lookup android android:integer/config_maxUiWidth')
    echo 1920 ;;
  'shell dumpsys window displays') echo 'fixture window display state' ;;
  'shell dumpsys display')
    echo 'fixture display state'
    exit "$FAKE_DISPLAY_DUMP_EXIT" ;;
  'shell dumpsys window windows')
    if [[ "$FAKE_WINDOW_EXIT" != 0 ]]; then echo 'fixture window dump failed' >&2; fi
    echo 'mCurrentFocus=Window{fixture.focus}'
    exit "$FAKE_WINDOW_EXIT" ;;
  'logcat -b all -d -v threadtime') echo 'simulated device boot log' ;;
  'logcat -d -v threadtime') echo 'simulated emulator log' ;;
  'logcat -c') ;;
  *) echo "Unexpected adb command: $*" >&2; exit 99 ;;
esac
""")
        adb.chmod(0o755)
        (self.root / "gradlew").write_text("""#!/usr/bin/env bash
set -eu
test "$ANDROID_SERIAL" = emulator-5554
echo gradle >> "$COMMAND_LOG"
printf '%s\\n' "$@" > "$GRADLE_ARGUMENTS"
test ! -f build/outputs/androidTest-results/connected/TEST-stale.xml
mkdir -p build/outputs/androidTest-results/connected build/reports/androidTests/connected
echo '<testsuite tests="1"><testcase name="fresh"/></testsuite>' > build/outputs/androidTest-results/connected/TEST-new.xml
echo 'fresh HTML report' > build/reports/androidTests/connected/index.html
if [[ -n "$FAKE_MUTATE_APK" ]]; then printf 'changed' > "$FAKE_MUTATE_APK"; fi
exit "$FAKE_EXIT"
""")
        self.commands = self.root / "commands.txt"
        self.arguments = self.root / "gradle-arguments.txt"
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        EMULATOR_PORT="5554", FAKE_API="34", FAKE_CR="", FAKE_EXIT="0",
                        FAKE_ENV_FAIL_COMMAND="none", FAKE_ADB_EXIT="17", FAKE_WINDOW_EXIT="0",
                        FAKE_DISPLAY_DUMP_EXIT="0", FAKE_MUTATE_APK="",
                        COMMAND_LOG=str(self.commands), GRADLE_ARGUMENTS=str(self.arguments))
        for name in ("BATTLECITY_ENGINE_DIAGNOSTICS", "BATTLECITY_TV_VBO_MODE"):
            self.env.pop(name, None)

    def run_script(self, version, *args):
        return subprocess.run(["bash", str(SCRIPT), version, *args], cwd=self.root, env=self.env,
                              text=True, capture_output=True, timeout=10)

    def stale(self, relative):
        path = self.root / relative / "TEST-stale.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stale report")
        return path

    def test_api34_requires_leanback_and_4k_without_system_settings(self):
        version = "34"
        run = self.run_script(version)
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        commands = self.commands.read_text()
        self.assertIn("adb shell wm size", commands)
        self.assertNotIn("shell settings", commands)
        self.assertNotIn("adb shell wm size ", commands)
        self.assertNotIn("adb shell wm density ", commands)
        self.assertNotIn("adb root", commands)
        self.assertNotIn("PAGE_SIZE", commands)
        self.assertNotIn("sdk_full", commands)
        self.assertNotIn("sdk_minor", commands)
        log = (self.root / f"build/diagnostics/api-{version}/preflight.txt").read_text()
        self.assertIn(f"Verified Android TV API {version}", log)
        self.assertIn("4K display 3840x2160", log)
        self.assertIn("effective display 1920x1080", log)
        configuration = (self.root / f"build/diagnostics/api-{version}/display-configuration.txt").read_text()
        self.assertIn("Physical density: 640", configuration)
        self.assertIn("config_maxUiWidth", configuration)
        self.assertIn("fixture window display state", configuration)
        diagnostics = self.root / "build/diagnostics/api-34"
        self.assertTrue((diagnostics / "runner-started").is_file())
        self.assertIn("google/tv/tv:14/BUILD/1234:user/release-keys",
                      (diagnostics / "device-fingerprint.txt").read_text())

    def test_diagnostics_and_vbo_arguments_reach_device_tests(self):
        version = "34"
        for diagnostic in (None, "true", "false"):
            for mode in (None, "default", "disabled"):
                with self.subTest(version=version, diagnostic=diagnostic, mode=mode):
                    for key, value in (("BATTLECITY_ENGINE_DIAGNOSTICS", diagnostic), ("BATTLECITY_TV_VBO_MODE", mode)):
                        if value is None:
                            self.env.pop(key, None)
                        else:
                            self.env[key] = value
                    run = self.run_script(version)
                    self.assertEqual(0, run.returncode, run.stdout + run.stderr)
                    args = self.arguments.read_text().splitlines()
                    self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityEngineDiagnostics=" + (diagnostic or "false"), args)
                    self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=" + (mode or "default"), args)

    def test_invalid_experiment_arguments_stop_tests_and_keep_diagnostics(self):
        for key, expected in (("BATTLECITY_ENGINE_DIAGNOSTICS", "must be true or false"),
                              ("BATTLECITY_TV_VBO_MODE", "must be default or disabled")):
            with self.subTest(key=key):
                self.env.pop("BATTLECITY_ENGINE_DIAGNOSTICS", None)
                self.env.pop("BATTLECITY_TV_VBO_MODE", None)
                self.env[key] = "yes"
                run = self.run_script("34")
                self.assertEqual(2, run.returncode)
                self.assertNotIn("gradle", self.commands.read_text().splitlines())
                diagnostic = self.root / "build/diagnostics/api-34"
                self.assertIn(expected, (diagnostic / "preflight.txt").read_text())
                self.assertIn("Runner exit status: 2", (diagnostic / "preflight.txt").read_text())
                self.assertTrue((diagnostic / "window-state.txt").exists())

    def test_unsupported_versions_are_rejected_before_any_device_command(self):
        for version in ("33", "35", "36", "37", "37.2", "36.1", "garbage"):
            with self.subTest(version=version):
                run = self.run_script(version)
                self.assertEqual(2, run.returncode)
                self.assertIn("Unsupported test platform", run.stderr)
                self.assertFalse(self.commands.exists())

    def test_wrong_api_cannot_reuse_old_reports(self):
        for requested, actual in (("34", "36"), ("34", "34.1"), ("34", "garbage")):
            with self.subTest(requested=requested, actual=actual):
                old = self.stale(f"build/outputs/androidTest-results/api-{requested}")
                self.env["FAKE_API"] = actual
                self.assertEqual(1, self.run_script(requested).returncode)
                self.assertFalse(old.exists())
                self.assertFalse(self.arguments.exists())

    def test_wrong_abi_cannot_run_tests_or_reuse_reports(self):
        for version, abi in (("34", "x86_64"), ("34", "armeabi-v7a"), ("34", "arm64-v8a")):
            with self.subTest(version=version, abi=abi):
                self.env.update(FAKE_API=version, FAKE_ABI=abi)
                old = self.stale(f"build/outputs/androidTest-results/api-{version}")
                self.assertEqual(1, self.run_script(version).returncode)
                self.assertFalse(old.exists())
                self.assertFalse(self.arguments.exists())

    def test_non_tv_images_are_rejected(self):
        version = "34"
        for features in ("", "feature:android.software.activities", "feature:android.software.leanback_only"):
            with self.subTest(version=version, features=features):
                self.env.update(FAKE_API=version, FAKE_FEATURES=features)
                run = self.run_script(version)
                self.assertEqual(1, run.returncode)
                self.assertFalse(self.arguments.exists())
                self.assertIn("requires android.software.leanback", run.stdout + run.stderr)

    def test_versioned_leanback_feature_and_crlf_properties_are_accepted(self):
        self.env.update(FAKE_API="34", FAKE_FEATURES="feature:android.software.leanback=1", FAKE_CR="\r")
        run = self.run_script("34")
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        self.assertIn(b"34\r\n", (self.root / "build/diagnostics/api-34/preflight.txt").read_bytes())

    def test_wrong_missing_malformed_or_cross_channel_display_is_rejected(self):
        cases = ("Physical size: 1920x1080", "Physical size: 2160x3840", "Override size: 3840x2160", "",
                 "Physical size: unknown",
                 "Physical size: 3840x2160\nOverride size: unknown",
                 "Physical size: 3840x2160\nPhysical size: 3840x2160",
                 "Physical size: 3840x2160\nOverride size: 3840x2160\nOverride size: 3840x2160")
        version = "34"
        for display in (*cases, "Physical size: 3840x2160\nOverride size: 3840x2160",
                        "Physical size: 3840x2160"):
            with self.subTest(version=version, display=display):
                self.env.update(FAKE_API=version, FAKE_DISPLAY=display)
                old = self.stale(f"build/outputs/androidTest-results/api-{version}")
                self.assertEqual(1, self.run_script(version).returncode)
                self.assertFalse(old.exists())
                self.assertFalse(self.arguments.exists())

    def test_auxiliary_display_query_failures_do_not_change_runner_status(self):
        for command in ("shell wm density", "shell cmd overlay lookup android android:integer/config_maxUiWidth",
                        "shell dumpsys window displays"):
            for status in ("0", "7"):
                with self.subTest(command=command, status=status):
                    self.env.update(FAKE_ENV_FAIL_COMMAND=command, FAKE_EXIT=status)
                    self.assertEqual(int(status), self.run_script("34").returncode)
                    configuration = (self.root / "build/diagnostics/api-34/display-configuration.txt").read_text()
                    self.assertIn("exit 17", configuration)
                    self.assertIn("fixture environment stderr", configuration)

    def test_environment_query_failures_preserve_output_and_exit_status(self):
        version = "34"
        for command in ("shell getprop ro.build.version.sdk", "shell getprop ro.product.cpu.abi", "shell pm list features", "shell wm size"):
            with self.subTest(version=version, command=command):
                self.env.update(FAKE_API=version, FAKE_ENV_FAIL_COMMAND=command)
                run = self.run_script(version)
                self.assertEqual(17, run.returncode)
                self.assertFalse(self.arguments.exists())
                log = (self.root / f"build/diagnostics/api-{version}/preflight.txt").read_text()
                self.assertIn("fixture environment stdout", log)
                self.assertIn("fixture environment stderr", log)
                self.assertIn("Runner exit status: 17", log)

    def test_success_replaces_stale_results_and_preserves_startup_log(self):
        version = "34"
        self.stale("build/outputs/androidTest-results/connected")
        old = self.stale(f"build/outputs/androidTest-results/api-{version}")
        startup = self.root / f"build/diagnostics/emulator-api-{version}/startup-logcat.txt"
        startup.parent.mkdir(parents=True, exist_ok=True)
        startup.write_text("emulator startup log")
        window = self.root / f"build/diagnostics/api-{version}/window-state.txt"
        window.parent.mkdir(parents=True, exist_ok=True)
        window.write_text("stale window dump")
        run = self.run_script(version)
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        self.assertFalse(old.exists())
        self.assertTrue((old.parent / "TEST-new.xml").exists())
        self.assertTrue((self.root / f"build/reports/androidTests/api-{version}/index.html").exists())
        self.assertEqual("emulator startup log", startup.read_text())
        self.assertFalse(window.exists())
        self.assertEqual("simulated device boot log\n", (window.parent / "boot-logcat.txt").read_text())
        self.assertEqual([line for line in self.commands.read_text().splitlines() if line == "gradle" or "logcat" in line],
                         ["adb logcat -b all -d -v threadtime", "adb logcat -c", "gradle", "adb logcat -d -v threadtime"])

    def test_disabled_run_preserves_test_failure_and_diagnostics(self):
        version = "34"
        with self.subTest(version=version):
            self.env.update(FAKE_API=version, FAKE_EXIT="7", BATTLECITY_TV_VBO_MODE="disabled")
            run = self.run_script(version)
            self.assertEqual(7, run.returncode)
            diagnostic = self.root / f"build/diagnostics/api-{version}"
            self.assertIn("simulated emulator log", (diagnostic / "device-logcat.txt").read_text())
            self.assertIn("fixture display state", (diagnostic / "display-state.txt").read_text())
            self.assertIn("mCurrentFocus=Window{fixture.focus}", (diagnostic / "window-state.txt").read_text())
            log = (diagnostic / "preflight.txt").read_text()
            self.assertIn("Render mode requested: disabled", log)
            self.assertIn("Runner exit status: 7", log)

    def test_result_copy_failure_does_not_replace_original_test_failure(self):
        copy = self.root / "bin/cp"
        copy.write_text("#!/usr/bin/env bash\nexit 23\n")
        copy.chmod(0o755)
        for status, expected in (("7", 7), ("0", 23)):
            with self.subTest(status=status):
                self.env["FAKE_EXIT"] = status
                self.assertEqual(expected, self.run_script("34").returncode)

    def test_logcat_failure_is_recorded_without_masking_device_exit(self):
        for status in ("0", "7"):
            with self.subTest(status=status):
                self.env.update(FAKE_ENV_FAIL_COMMAND="logcat -d -v threadtime", FAKE_EXIT=status)
                self.assertEqual(int(status), self.run_script("34").returncode)
                log = (self.root / "build/diagnostics/api-34/preflight.txt").read_text()
                self.assertIn("Logcat exit status: 17", log)
                self.assertIn(f"Runner exit status: {status}", log)

    def test_boot_log_failure_keeps_test_log_and_test_status(self):
        self.env.update(FAKE_ENV_FAIL_COMMAND="logcat -b all -d -v threadtime")
        for status in ("0", "7"):
            with self.subTest(status=status):
                self.env["FAKE_EXIT"] = status
                self.assertEqual(int(status), self.run_script("34").returncode)
                diagnostics = self.root / "build/diagnostics/api-34"
                self.assertIn("fixture environment stderr", (diagnostics / "boot-logcat.txt").read_text())
                self.assertIn("Boot logcat exit status: 17\nLogcat exit status: 0\n",
                              (diagnostics / "preflight.txt").read_text())
                self.assertIn("simulated emulator log", (diagnostics / "device-logcat.txt").read_text())

    def build_fixture_apks(self):
        for relative in APKS:
            apk = self.root / relative
            apk.parent.mkdir(parents=True)
            apk.write_text(relative)
        manifest = self.root / "build/diagnostics/apks-built.sha256"
        manifest.parent.mkdir(parents=True)
        manifest.write_bytes(subprocess.check_output(["sha256sum", *APKS], cwd=self.root))
        return manifest.read_bytes()

    def test_failed_baseline_is_archived_before_the_comparison_reuses_the_apks(self):
        manifest = self.build_fixture_apks()
        self.env["FAKE_EXIT"] = "7"
        self.assertEqual(7, self.run_script("34", "baseline").returncode)
        self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=default", self.arguments.read_text())
        self.env["FAKE_EXIT"] = "0"
        run = self.run_script("34", "comparison-1")
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        args = self.arguments.read_text().splitlines()
        self.assertIn("-Pandroid.testInstrumentationRunnerArguments.battlecityVboMode=disabled", args)
        for task in ("compileDebugJavaWithJavac", "compileDebugAndroidTestJavaWithJavac",
                     "packageDebug", "packageDebugAndroidTest"):
            self.assertEqual("-x", args[args.index(task) - 1])
        for name, status in (("baseline", "7"), ("comparison-1", "0")):
            diagnostics = self.root / "build/diagnostics/api-34" / name
            self.assertIn(f"Runner exit status: {status}", (diagnostics / "preflight.txt").read_text())
            for phase in ("before", "after"):
                self.assertEqual(manifest, (diagnostics / f"apks-{phase}.sha256").read_bytes())
            self.assertTrue((self.root / "build/outputs/androidTest-results/api-34" / name / "TEST-new.xml").is_file())
            self.assertTrue((self.root / "build/reports/androidTests/api-34" / name / "index.html").is_file())

    def test_changed_apk_fails_round_and_blocks_later_execution(self):
        manifest = self.build_fixture_apks()
        self.env["FAKE_MUTATE_APK"] = APKS[0]
        after_change = self.run_script("34", "baseline")
        self.assertEqual(1, after_change.returncode)
        self.assertIn("APK digest verification failed after device tests", after_change.stderr)
        baseline = self.root / "build/diagnostics/api-34/baseline"
        self.assertEqual(manifest, (baseline / "apks-before.sha256").read_bytes())
        self.assertNotEqual(manifest, (baseline / "apks-after.sha256").read_bytes())
        self.commands.unlink()
        before_run = self.run_script("34", "comparison-1")
        self.assertEqual(1, before_run.returncode)
        self.assertIn("APK digest verification failed before device tests", before_run.stderr)
        self.assertNotIn("gradle", self.commands.read_text().splitlines())

    def test_diagnostic_dump_failures_do_not_mask_test_status(self):
        self.env.update(FAKE_WINDOW_EXIT="19", FAKE_DISPLAY_DUMP_EXIT="18")
        for status in ("0", "7"):
            with self.subTest(status=status):
                self.env["FAKE_EXIT"] = status
                self.assertEqual(int(status), self.run_script("34").returncode)
                self.assertIn("fixture display state", (self.root / "build/diagnostics/api-34/display-state.txt").read_text())


class EmulatorMetadataTest(unittest.TestCase):
    def test_watch_records_unauthorized_transport_before_the_runner_starts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            adb = root / "platform-tools/adb"
            bin_dir = root / "bin"
            host = root / "build/diagnostics/emulator-api-34/baseline"
            for directory in (adb.parent, bin_dir, host):
                directory.mkdir(parents=True)
            adb.write_text("""#!/usr/bin/env bash
case "$*" in
  'devices -l') echo 'emulator-5554 unauthorized' ;;
  '-s emulator-5554 get-state') echo 'adb: device unauthorized' >&2; exit 1 ;;
  *) exit 99 ;;
esac
""")
            pause = bin_dir / "sleep"
            pause.write_text('#!/usr/bin/env bash\ntouch "$STOP_WATCH"\n')
            adb.chmod(0o755)
            pause.chmod(0o755)
            env = dict(os.environ, ANDROID_HOME=str(root), STOP_WATCH=str(host / "stop-adb-watch"),
                       PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])
            run = subprocess.run(["bash", str(PREPARE), "watch", "baseline", "5554"], cwd=root, env=env,
                                 text=True, capture_output=True, timeout=10)
            self.assertEqual(0, run.returncode, run.stderr)
            self.assertIn("emulator-5554 unauthorized", run.stdout)
            self.assertIn("adb: device unauthorized", run.stderr)

    def test_prelaunch_preserves_each_available_image_file_without_running_the_emulator(self):
        for source, output in (("source.properties", "image.properties"), ("package.xml", "image-package.xml")):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                sdk = root / "test sdk"
                image = sdk / "system-images/android-34/android-tv/x86"
                image.mkdir(parents=True)
                (image / source).write_text("metadata from " + source)
                adb = sdk / "platform-tools/adb"
                adb.parent.mkdir()
                adb.write_text("""#!/usr/bin/env bash
case "$1" in
  keygen) touch "$2" "$2.pub" ;;
  kill-server) exit 1 ;;
  start-server) test "$ADB_VENDOR_KEYS" = "$ANDROID_EMULATOR_HOME/adbkey" && test -f "$ADB_VENDOR_KEYS" ;;
  version) echo 'fixture adb version' ;;
esac
""")
                adb.chmod(0o755)
                env = dict(os.environ, ANDROID_HOME=str(sdk), RUNNER_TEMP=str(root), GITHUB_ENV=str(root / "github-env"))
                authorize = subprocess.run(["bash", str(PREPARE), "authorize"], cwd=root, env=env,
                                           text=True, capture_output=True, timeout=10)
                self.assertEqual(0, authorize.returncode, authorize.stderr)
                env.update(line.split("=", 1) for line in (root / "github-env").read_text().splitlines())
                self.assertEqual(env["ANDROID_USER_HOME"], env["ANDROID_EMULATOR_HOME"])
                device = root / "build/diagnostics/api-34/baseline"
                device.mkdir(parents=True)
                (device / "runner-started").touch()
                prepare = subprocess.run(["bash", str(PREPARE), "prepare", "baseline", "5554"], cwd=root, env=env,
                                         text=True, capture_output=True, timeout=10)
                self.assertEqual(0, prepare.returncode, prepare.stderr)
                diagnostics = root / "build/diagnostics/emulator-api-34/baseline"
                self.assertEqual("metadata from " + source, (diagnostics / output).read_text())
                self.assertEqual("fixture adb version\n", (diagnostics / "adb-setup.txt").read_text())
                self.assertFalse((diagnostics / "adbkey").exists())


class KvmPreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Exercise the actual workflow script without accessing the host KVM device.
        self.node = self.root / "kvm"
        self.node.symlink_to("/dev/null")
        step = WORKFLOW.read_text().split("      - name: Enable emulator acceleration\n", 1)[1]
        step = step.split("      - name: ", 1)[0]
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
