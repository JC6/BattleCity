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
case "$*" in
  'shell getprop ro.build.version.sdk') echo "$FAKE_API" ;;
  'shell getprop ro.build.version.sdk_minor') echo "$FAKE_MINOR" ;;
  'logcat -d -v threadtime') echo 'simulated emulator log' ;;
esac
""")
        adb.chmod(0o755)
        (self.root / "gradlew").write_text("""#!/usr/bin/env bash
set -eu
test "$ANDROID_SERIAL" = emulator-5554
test ! -f build/outputs/androidTest-results/connected/TEST-stale.xml
mkdir -p build/outputs/androidTest-results/connected
echo '<testsuite tests="1"><testcase name="fresh"/></testsuite>' > build/outputs/androidTest-results/connected/TEST-new.xml
exit "$FAKE_EXIT"
""")
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        EMULATOR_PORT="5554", FAKE_API="34", FAKE_MINOR="0", FAKE_EXIT="0")

    def stale(self, relative):
        path = self.root / relative / "TEST-stale.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stale report")
        return path

    def run_script(self, version):
        return subprocess.run(["bash", str(SCRIPT), version], cwd=self.root, env=self.env,
                              text=True, capture_output=True, timeout=10)

    def test_success_replaces_stale_results_and_preserves_other_platform(self):
        self.stale("build/outputs/androidTest-results/connected")
        stale = self.stale("build/outputs/androidTest-results/api-34")
        other = self.stale("build/outputs/androidTest-results/api-37.2")
        startup = self.root / "build/diagnostics/emulator-api-34/startup-logcat.txt"
        startup.parent.mkdir(parents=True)
        startup.write_text("log captured before the test script started")
        run = self.run_script("34")
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertFalse(stale.exists())
        self.assertTrue(other.exists())
        self.assertTrue((stale.parent / "TEST-new.xml").exists())
        self.assertEqual("log captured before the test script started", startup.read_text())

    def test_failed_test_command_preserves_failure_and_diagnostics(self):
        self.env.update(FAKE_API="37", FAKE_MINOR="2", FAKE_EXIT="7")
        run = self.run_script("37.2")
        self.assertEqual(7, run.returncode, run.stderr)
        self.assertTrue((self.root / "build/outputs/androidTest-results/api-37.2/TEST-new.xml").exists())
        log = self.root / "build/diagnostics/api-37.2/device-logcat.txt"
        self.assertIn("simulated emulator log", log.read_text())

    def test_wrong_major_or_minor_version_cannot_reuse_old_reports(self):
        for api, minor in (("34", "0"), ("37", "0")):
            with self.subTest(api=api, minor=minor):
                stale = self.stale("build/outputs/androidTest-results/api-37.2")
                self.env.update(FAKE_API=api, FAKE_MINOR=minor)
                self.assertNotEqual(0, self.run_script("37.2").returncode)
                self.assertEqual([], list(stale.parent.glob("TEST-*.xml")))


class KvmPreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Exercise the actual workflow script without accessing the host KVM device.
        self.node = self.root / "kvm"
        self.node.symlink_to("/dev/null")
        step = WORKFLOW.read_text().split("      - name: Enable emulator acceleration\n", 1)[1]
        step = step.split("      - name: API 34 framework smoke tests\n", 1)[0]
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
