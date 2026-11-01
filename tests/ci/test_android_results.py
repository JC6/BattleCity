"""Exercise false-green failure modes of the CI artifact gate without Android dependencies."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from subprocess import CompletedProcess
import xml.etree.ElementTree as ET


spec = importlib.util.spec_from_file_location(
    "android_results", Path(__file__).resolve().parents[2] / "tools/check-android-results.py"
)
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)


class AcceptanceResultsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.build = Path(self.temporary.name)
        for _, relative, count in results.GROUPS:
            self.write_report(relative, count)
        lint = self.build / "reports/lint-results-debug.xml"
        lint.parent.mkdir(parents=True)
        lint.write_text('<issues><issue severity="Warning"/></issues>')
        test_apk = self.build / "outputs/apk/androidTest/debug/BattleCity-debug-androidTest.apk"
        test_apk.parent.mkdir(parents=True)
        test_apk.write_bytes(b"fixture instrumentation APK")
        apk = self.build / "outputs/apk/debug/BattleCity-debug.apk"
        apk.parent.mkdir(parents=True)
        apk.write_bytes(b"fixture APK; not an installable build")

    def write_report(self, relative, count, outcome=None, wrapped=False):
        suite = ET.Element("testsuite", tests=str(count), failures="0", errors="0", skipped="0")
        for index in range(count):
            case = ET.SubElement(suite, "testcase", classname="Fixture", name=f"test{index}")
            if index == 0 and outcome:
                ET.SubElement(case, outcome)
        root = ET.Element("testsuites") if wrapped else suite
        if wrapped:
            root.append(suite)
        path = self.build / relative / "TEST-fixture.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        ET.ElementTree(root).write(path)
        return path

    def evaluate(self, build_status="success", device_status="success", device_statuses=None):
        statuses = {"34": device_status, "37.2": device_status} if device_statuses is None else device_statuses
        return results.evaluate(self.build, build_status, statuses, "fixture-commit")

    def test_local_mode_never_claims_device_acceptance(self):
        for _, relative, _ in results.GROUPS[1:]:
            (self.build / relative / "TEST-fixture.xml").unlink()
        summary, problems = results.evaluate(self.build, "success", {}, "workspace", local=True)
        self.assertEqual([], problems)
        self.assertIn("Device tests: **NOT RUN**", summary)
        self.assertIn("device validation pending", summary)
        self.assertTrue(results.evaluate(self.build, "success", {}, "workspace")[1])
        self.assertTrue(results.evaluate(self.build, "failure", {}, "workspace", local=True)[1])

    def test_lint_and_instrumentation_artifact_are_required(self):
        lint = self.build / "reports/lint-results-debug.xml"
        lint.write_text('<issues><issue severity="Error"/></issues>')
        self.assertTrue(self.evaluate()[1])
        lint.unlink()
        self.assertTrue(self.evaluate()[1])
        lint.write_text('<issues/>')
        (self.build / "outputs/apk/androidTest/debug/BattleCity-debug-androidTest.apk").unlink()
        self.assertTrue(self.evaluate()[1])

    def signature_result(self, outputs):
        with mock.patch.dict(results.os.environ, {"ANDROID_HOME": "", "ANDROID_SDK_ROOT": ""}), \
             mock.patch.object(results.shutil, "which", return_value="fixture-apksigner"), \
             mock.patch.object(results.subprocess, "run", side_effect=[CompletedProcess([], 0, "fixture-version\n", "")] + outputs) as run:
            result = results.verify_apks(self.build)
            self.assertEqual(["fixture-apksigner", "version"], run.call_args_list[0].args[0])
            self.assertEqual(3, run.call_count, "Both APKs must be checked even after the first failure")
            return result

    @staticmethod
    def signed(certificate="ab" * 32):
        return CompletedProcess([], 0, f"Signer #1 certificate SHA-256 digest: {certificate}\n", "")

    def test_both_apk_signatures_require_the_same_certificate(self):
        summary, errors = self.signature_result([self.signed(), self.signed()])
        self.assertFalse(errors)
        self.assertIn("ab" * 32, summary)
        self.assertTrue(self.signature_result([self.signed(), self.signed("cd" * 32)])[1])
        self.assertFalse(self.signature_result([self.signed("AB" * 32), self.signed()])[1])

    def test_build_tools_37_output_from_ci_is_accepted(self):
        stdout = """V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug
V2 Signer: certificate SHA-256 digest: e77966598fe6df86fd91cf526e83b9a5b25be0e9629783d5ddfd812719532598
V2 Signer: certificate SHA-1 digest: 38fa90a85b871fdc14144d356257c3b6ed8ec0cd
V2 Signer: certificate MD5 digest: 4efa2d677cea1f1aff0d97c3353d7047
"""
        signed = CompletedProcess([], 0, stdout, "")
        summary, errors = self.signature_result([signed, signed])
        self.assertFalse(errors)
        self.assertIn("e77966598fe6df86fd91cf526e83b9a5b25be0e9629783d5ddfd812719532598", summary)

    def test_mixed_and_repeated_signer_records_require_one_unique_certificate(self):
        legacy = self.signed().stdout
        v2 = self.signed("AB" * 32).stdout.replace("Signer #1", "V2 Signer:")
        duplicate = CompletedProcess([], 0, (legacy + v2 + v2).replace("\n", "\r\n"), "")
        self.assertFalse(self.signature_result([duplicate, self.signed()])[1])
        for extra in (self.signed("cd" * 32).stdout.replace("Signer #1", "Signer #2"),
                      self.signed("cd" * 32).stdout.replace("Signer #1", "V2 Signer:"),
                      self.signed("malformed").stdout.replace("Signer #1", "V2 Signer:")):
            with self.subTest(extra=extra):
                self.assertTrue(self.signature_result([CompletedProcess([], 0, legacy + extra, ""), self.signed()])[1])

    def test_other_certificate_and_key_digests_cannot_replace_a_signer(self):
        valid = self.signed().stdout
        for output in (valid.replace("Signer #1", "Source Stamp Signer"),
                       valid.replace("certificate", "public key"),
                       valid.replace("SHA-256", "SHA-1"),
                       "WARNING: " + valid):
            with self.subTest(output=output):
                self.assertTrue(self.signature_result([CompletedProcess([], 0, output, ""), self.signed()])[1])

    def test_failed_verification_cannot_accept_a_valid_printed_certificate(self):
        output = self.signed().stdout.replace("Signer #1", "V2 Signer:")
        failed = CompletedProcess([], 9, output, "fixture verification failure")
        summary, errors = self.signature_result([failed, self.signed()])
        self.assertIn("**FAILED**", summary)
        self.assertEqual(1, len(errors))
        self.assertIn("exit code 9", errors[0])

    def test_invalid_or_missing_signer_cannot_report_signatures_passed(self):
        self.assertTrue(self.signature_result([CompletedProcess([], 1, "", "invalid"), self.signed()])[1])
        with mock.patch.dict(results.os.environ, {"ANDROID_HOME": "", "ANDROID_SDK_ROOT": ""}), \
             mock.patch.object(results.shutil, "which", return_value=None):
            self.assertTrue(results.verify_apks(self.build)[1])

    def test_signature_failures_preserve_both_commands_and_all_output(self):
        invalid = CompletedProcess([], 7, "fixture stdout", "fixture verification error")
        summary, errors = self.signature_result([invalid, CompletedProcess([], 9, "second stdout", "second error")])
        self.assertIn("**FAILED**", summary)
        self.assertEqual(2, len(errors))
        diagnostics = self.build / "diagnostics/apk-signatures"
        tool = (diagnostics / "tool.txt").read_text()
        self.assertIn("fixture-apksigner", tool)
        self.assertIn("fixture-version", tool)
        self.assertIn("Version exit code: 0", tool)
        first = (diagnostics / "BattleCity-debug.apk.txt").read_text()
        self.assertIn("Exit code: 7", first)
        self.assertIn("fixture stdout", first)
        self.assertIn("fixture verification error", first)
        second = (diagnostics / "BattleCity-debug-androidTest.apk.txt").read_text()
        self.assertIn("Exit code: 9", second)
        self.assertIn("second stdout", second)
        self.assertIn("second error", second)
        for error in errors:
            self.assertIn("diagnostics/apk-signatures/", error)

    def test_missing_or_malformed_certificate_fails_even_with_successful_exit(self):
        for label in ("Signer #1", "V2 Signer:"):
            for certificate in ("", "aabb", "a" * 65, "z" * 64, "ab" * 32 + " "):
                with self.subTest(label=label, certificate=certificate):
                    malformed = self.signed(certificate)
                    malformed.stdout = malformed.stdout.replace("Signer #1", label)
                    self.assertTrue(self.signature_result([malformed, self.signed()])[1])

    def test_unstartable_signer_still_records_both_apk_attempts(self):
        summary, errors = self.signature_result([OSError("fixture launch error"), OSError("second launch error")])
        self.assertIn("**NOT VERIFIED**", summary)
        self.assertEqual(2, len(errors))
        diagnostics = self.build / "diagnostics/apk-signatures"
        self.assertIn("fixture launch error", (diagnostics / "BattleCity-debug.apk.txt").read_text())
        self.assertIn("second launch error", (diagnostics / "BattleCity-debug-androidTest.apk.txt").read_text())

    def test_signer_path_and_version_failure_are_recorded_without_skipping_verification(self):
        sdk = self.build / "sdk"
        for version in ("36.0.0", "37.0.0"):
            tool = sdk / "build-tools" / version / "apksigner"
            tool.parent.mkdir(parents=True)
            tool.touch()
        expected = str(sdk / "build-tools/37.0.0/apksigner")
        with mock.patch.dict(results.os.environ, {"ANDROID_HOME": str(sdk)}), \
             mock.patch.object(results.subprocess, "run", side_effect=[
                 CompletedProcess([], 1, "", "fixture version error"), self.signed(), self.signed()
             ]) as run:
            self.assertFalse(results.verify_apks(self.build)[1])
            self.assertTrue(all(call.args[0][0] == expected for call in run.call_args_list))
        tool_log = (self.build / "diagnostics/apk-signatures/tool.txt").read_text()
        self.assertIn(expected, tool_log)
        self.assertIn("Version exit code: 1", tool_log)
        self.assertIn("fixture version error", tool_log)

    def test_complete_run_reports_counts_commit_and_checksum(self):
        summary, problems = self.evaluate()
        self.assertEqual([], problems)
        for expected in ["**PASSED**", "fixture-commit", "APK SHA-256:"] + [
                f"| {label} | {count} | 0 | 0 | 0 |" for label, _, count in results.GROUPS]:
            self.assertIn(expected, summary)

    def test_missing_zero_or_incomplete_device_results_fail(self):
        for label, relative, minimum in results.GROUPS[1:]:
            for count in [None, 0, minimum - 1]:
                with self.subTest(suite=label, count=count):
                    path = self.write_report(relative, count or 0)
                    if count is None:
                        path.unlink()
                    summary, problems = self.evaluate()
                    self.assertTrue(problems)
                    self.assertIn("**NOT ACCEPTED**", summary)
                    self.write_report(relative, minimum)

    def test_failed_errored_and_skipped_cases_fail_even_with_zero_suite_totals(self):
        for label, relative, minimum in results.GROUPS[1:]:
            for outcome in ["failure", "error", "skipped"]:
                with self.subTest(suite=label, outcome=outcome):
                    self.write_report(relative, minimum, outcome)
                    self.assertTrue(self.evaluate()[1])
                    self.write_report(relative, minimum)

    def test_each_platform_requires_its_own_success_status(self):
        for version in ("34", "37.2"):
            for status in (None, "failure", "skipped", "cancelled", "not run"):
                with self.subTest(version=version, status=status):
                    statuses = {"34": "success", "37.2": "success"}
                    if status is None:
                        del statuses[version]
                    else:
                        statuses[version] = status
                    self.assertTrue(self.evaluate(device_statuses=statuses)[1])

    def test_unseparated_reports_cannot_replace_a_missing_platform(self):
        self.write_report("outputs/androidTest-results/connected", 100)
        for _, relative, minimum in results.GROUPS[1:]:
            with self.subTest(relative=relative):
                (self.build / relative / "TEST-fixture.xml").unlink()
                self.assertTrue(self.evaluate()[1])
                self.write_report(relative, minimum)

    def test_suite_level_runner_error_is_not_ignored(self):
        path = self.build / results.GROUPS[1][1] / "TEST-runner.xml"
        path.write_text('<testsuite tests="0" errors="1"/>')
        self.assertTrue(self.evaluate()[1])

    def test_malformed_and_inconsistent_reports_fail(self):
        path = self.build / results.GROUPS[1][1] / "TEST-fixture.xml"
        for content in ["broken XML", '<testsuite tests="6"/>', '<testsuite tests="-1"/>']:
            with self.subTest(content=content):
                path.write_text(content)
                self.assertTrue(self.evaluate()[1])

    def test_failed_or_skipped_steps_cannot_accept_existing_reports(self):
        for build_status, device_status in [("failure", "success"), ("success", "failure"),
                                             ("success", "skipped"), ("cancelled", "skipped")]:
            with self.subTest(build=build_status, device=device_status):
                self.assertTrue(self.evaluate(build_status, device_status)[1])

    def test_missing_or_empty_apk_fails(self):
        apk = self.build / "outputs/apk/debug/BattleCity-debug.apk"
        apk.write_bytes(b"")
        self.assertTrue(self.evaluate()[1])
        apk.unlink()
        self.assertTrue(self.evaluate()[1])

    def test_wrapped_suites_and_additional_tests_are_counted(self):
        count = results.GROUPS[1][2] + 1
        self.write_report(results.GROUPS[1][1], count, wrapped=True)
        summary, problems = self.evaluate()
        self.assertEqual([], problems)
        self.assertIn(f"| API 34 device | {count} | 0 | 0 | 0 |", summary)


if __name__ == "__main__":
    unittest.main()
