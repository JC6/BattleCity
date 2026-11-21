"""Exercise false-green failure modes of the CI artifact gate without Android dependencies."""

import importlib.util
import hashlib
import json
from argparse import Namespace
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
        self.write_render_evidence("34")
        directory = self.build / "diagnostics/api-34"
        directory.mkdir(parents=True)
        (directory / "preflight.txt").write_text("Logcat exit status: 0\n")
        (directory / "device-logcat.txt").write_text("I TestRunner: finished\n")
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

    def write_render_evidence(self, platform, mode="default", round_name="", **changes):
        scale = 4
        record = dict(api=int(platform.split('.')[0]), requested=mode, activeVbo=mode == "default", optionsDisabled=mode == "disabled",
                      renderer="Android Emulator OpenGL ES Translator (Google SwiftShader)", version="Fixture GL version",
                      displayWidth=3840, displayHeight=2160,
                      windowWidth=1920, windowHeight=1080,
                      surfaceWidth=256 * scale, surfaceHeight=240 * scale, scale=scale)
        record.update(changes)
        path = self.build / f"outputs/androidTest-results/api-{platform}" / round_name / "debug/fixture" / (
            "logcat-org.jiangc.bc.TvMenuFlowTest-actualGlAdapterMatchesSoftwareAcrossSpriteSizesAndPausedScreens.txt")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("I BattleCityRenderMode: BATTLECITY_RENDER_MODE " + json.dumps(record) + "\n")
        return path

    def evaluate(self, build_status="success", device_status="success", tv_vbo_mode="default"):
        return results.evaluate(self.build, build_status, device_status, "fixture-commit", tv_vbo_mode=tv_vbo_mode)

    def test_system_anr_fails_even_with_passing_junit(self):
        log = self.build / "diagnostics/api-34/device-logcat.txt"
        for line in ("WindowManager: ANR in Window{abc u0 org.jiangc.bc/.MainMenuActivity}",
                     "ActivityManager: ANR in org.jiangc.bc (org.jiangc.bc/.MainMenuActivity)"):
            with self.subTest(line=line):
                log.write_text(line + "\n")
                summary, problems = self.evaluate()
                self.assertIn("API 34: system log reports a BattleCity ANR", problems)
                self.assertIn(line, summary)
                self.assertIn("| API 34 TV / 4K display / 1080p window | 46 | 0 | 0 | 0 |", summary)
                self.assertIn("**NOT ACCEPTED**", summary)

    def test_unrelated_anr_and_watchdog_are_informational(self):
        log = self.build / "diagnostics/api-34/device-logcat.txt"
        log.write_text("ActivityManager: ANR in org.jiangc.bc.other\n"
                       "WindowManager: ANR in Window{abc u0 com.android.tv/.Home}\n"
                       "BattleCityTest: watchdog test=org.jiangc.bc.Test sample=1 waitingMillis=4000\n")
        self.assertFalse(self.evaluate()[1])

    def test_passing_device_requires_collected_system_log(self):
        directory = self.build / "diagnostics/api-34"
        log = directory / "device-logcat.txt"
        log.unlink()
        self.assertTrue(self.evaluate()[1])
        log.write_text("  \n")
        self.assertTrue(self.evaluate()[1])
        log.write_text("I TestRunner: finished\n")
        (directory / "preflight.txt").write_text("Logcat exit status: 1\n")
        self.assertTrue(self.evaluate()[1])

    def test_disabled_vbo_success_is_diagnostic_only(self):
        self.write_render_evidence("34", "disabled")
        summary, problems = self.evaluate(tv_vbo_mode="disabled")
        self.assertEqual([], problems)
        self.assertIn(results.DIAGNOSTIC_SUCCESS, summary)
        self.assertNotIn("**PASSED**", summary)
        self.assertIn("| API 34 | disabled | false |", summary)

    def test_missing_malformed_or_contradictory_render_evidence_fails(self):
        path = self.write_render_evidence("34")
        valid = path.read_text()
        for content in (None, "I BattleCityRenderMode: BATTLECITY_RENDER_MODE {bad}\n",
                        valid + "I BattleCityRenderMode: BATTLECITY_RENDER_MODE {}\n"):
            with self.subTest(content=content):
                if content is None:
                    path.unlink()
                else:
                    path.write_text(content)
                self.assertTrue(self.evaluate()[1])

    def test_requested_mode_options_actual_state_and_driver_details_are_required(self):
        for changes in ({"requested": "disabled"}, {"activeVbo": False}, {"activeVbo": "true"},
                        {"api": 36}, {"api": "34"}, {"api": True}, {"api": None},
                        {"optionsDisabled": True}, {"optionsDisabled": 0},
                        {"renderer": ""}, {"renderer": None}, {"version": " "}):
            with self.subTest(changes=changes):
                self.write_render_evidence("34", **changes)
                self.assertTrue(self.evaluate()[1])

    def test_disabled_requires_effective_disabled_evidence(self):
        self.assertTrue(self.evaluate(tv_vbo_mode="disabled")[1])

    def test_other_software_backends_do_not_pass_swiftshader_gate(self):
        for renderer in ("ANGLE (Google, Vulkan, SwiftShader)", "Mesa llvmpipe", "Emulator GLES"):
            with self.subTest(renderer=renderer):
                self.write_render_evidence("34", renderer=renderer)
                summary, problems = self.evaluate()
                self.assertTrue(problems)
                self.assertIn("expected SwiftShader GLES renderer", summary)
        self.write_render_evidence("34", version="OpenGL ES 3.1 (ANGLE)")
        self.assertTrue(self.evaluate()[1])

    def test_4k_display_and_application_window_evidence_is_required(self):
        for changes in ({"displayWidth": 1920}, {"displayHeight": 1080},
                        {"windowWidth": 3840}, {"windowHeight": 2160},
                        {"windowWidth": "3840"}, {"displayWidth": True},
                        {"windowHeight": None}, {"scale": 8.0}):
            with self.subTest(changes=changes):
                self.write_render_evidence("34", **changes)
                self.assertTrue(self.evaluate()[1])
        path = self.write_render_evidence("34")
        record = json.loads(path.read_text().split("BATTLECITY_RENDER_MODE ", 1)[1])
        del record["surfaceWidth"]
        path.write_text("BATTLECITY_RENDER_MODE " + json.dumps(record))
        self.assertTrue(self.evaluate()[1])

    def test_surface_must_use_one_integer_scale_and_fit_the_window(self):
        for changes in ({"scale": 0}, {"scale": -1}, {"scale": True},
                        {"surfaceWidth": 2047}, {"surfaceHeight": 1919},
                        {"surfaceWidth": 2048, "surfaceHeight": 960},
                        {"surfaceWidth": 4096, "surfaceHeight": 3840, "scale": 16}):
            with self.subTest(changes=changes):
                self.write_render_evidence("34", **changes)
                self.assertTrue(self.evaluate()[1])
        self.write_render_evidence("34", surfaceWidth=768, surfaceHeight=720, scale=3)
        summary, problems = self.evaluate()
        self.assertFalse(problems)
        self.assertIn("3840x2160 | 1920x1080 | 768x720 | 3 |", summary)

    def test_emulator_evidence_distinguishes_boot_failure_from_device_test_failure(self):
        host = self.build / "diagnostics/emulator-api-34"
        host.mkdir(parents=True)
        (host / "version.txt").write_text("error while loading shared libraries: libpulse.so.0\n")
        (host / "image.properties").write_text("Pkg.Revision=3\n")
        (host / "host-startup.txt").write_text("fixture startup error\n")
        summary, problems = self.evaluate(device_status="failure")
        self.assertTrue(problems)
        for expected in ("Device test script: not started", "Emulator version: unavailable",
                         "TV image revision: 3", "emulator-api-34/host-startup.txt"):
            self.assertIn(expected, summary)
        diagnostics = self.build / "diagnostics/api-34"
        (host / "host-startup.txt").write_text("INFO | Android emulator version 37.3.10.0 (build_id 16970787) (CL:N/A)\n")
        (diagnostics / "runner-started").touch()
        (diagnostics / "boot-logcat.txt").touch()
        fingerprint = "google/tv/tv:14/BUILD/1234:user/release-keys"
        (diagnostics / "device-fingerprint.txt").write_text(
            "adb shell getprop ro.build.fingerprint (exit 0):\n" + fingerprint + "\n")
        summary, _ = self.evaluate(device_status="failure")
        for expected in ("Device test script: started", "Emulator version: 37.3.10.0 (build_id 16970787)",
                         fingerprint, "VBO environment comparison: complete", "api-34/boot-logcat.txt"):
            self.assertIn(expected, summary)
        (diagnostics / "device-fingerprint.txt").write_text(
            "adb shell getprop ro.build.fingerprint (exit 1):\n" + fingerprint + "\n")
        summary, _ = self.evaluate(device_status="failure")
        self.assertIn("VBO environment comparison: unavailable (Device build fingerprint)", summary)

    def test_tv_image_revision_prefers_properties_and_falls_back_to_matching_local_package(self):
        host = self.build / "diagnostics/emulator-api-34"
        host.mkdir(parents=True)
        properties = host / "image.properties"
        package = host / "image-package.xml"
        xml = (
            '<repository xmlns="urn:android:sdk">'
            '<localPackage path="system-images;android-34;android-tv;x86">'
            '<revision><major>2</major><minor>1</minor><micro>0</micro></revision>'
            '</localPackage></repository>'
        )
        package.write_text(xml)
        properties.write_text("Pkg.Revision=3.0.0\n")
        self.assertEqual("3", results.read_image_revision(host))
        properties.write_text("Pkg.Revision=   \nPkg.Desc=Android TV\n")
        self.assertEqual("2.1", results.read_image_revision(host))
        properties.unlink()
        self.assertEqual("2.1", results.read_image_revision(host))
        for invalid in (xml.replace("x86", "x86_64"), xml.replace(">2<", ">bad<"), "<malformed>"):
            package.write_text(invalid)
            self.assertEqual("", results.read_image_revision(host))

    def test_device_gl_diagnoses_interrupted_run_without_replacing_pixel_evidence(self):
        self.write_render_evidence("34").unlink()
        host = self.build / "diagnostics/emulator-api-34"
        host.mkdir(parents=True)
        (host / "host-startup.txt").write_text("INFO | Android emulator version 37.3.10.0 (build_id 16970787)\n")
        (host / "image.properties").write_text("Pkg.Revision=3\n")
        device = self.build / "diagnostics/api-34"
        (device / "runner-started").touch()
        (device / "device-fingerprint.txt").write_text(
            "adb shell getprop ro.build.fingerprint (exit 0):\ngoogle/tv/tv:14/BUILD/1234:user/release-keys\n")
        log = device / "device-logcat.txt"
        renderer = "Android Emulator OpenGL ES Translator (Google SwiftShader)"
        version = "OpenGL ES-CM 1.1 (OpenGL ES 3.0 SwiftShader 4.0.0.1)"
        render_line = f"11-21 00:36:53.536  2986  3150 D AndEngine: RENDERER: {renderer}\n"
        version_line = f"11-21 00:36:53.536  2986  3150 D AndEngine: VERSION: {version}\n"
        watchdog_case = "remainingSecondControllerCanStartFromTitleAfterPairDisconnects"
        sample = f"BattleCityTest: watchdog test=org.jiangc.bc.TvMenuFlowTest#{watchdog_case} sample=2 heartbeat=14 stallSample=2 | "
        watchdog = "\n".join(sample + detail for detail in (
            "phase=teardown waitingMillis=4052",
            "at GLImpl.glGenBuffers(Native Method)",
            "at BufferObject.loadToHardware(BufferObject.java:93)",
            "at GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)",
        ))
        anr = "WindowManager: ANR in Window{abc u0 org.jiangc.bc/.Level1Activity}\n"
        log.write_text(render_line + version_line + watchdog + "\n" + anr)
        summary, problems = self.evaluate(device_status="failure")
        for expected in (f"Device GL (AndEngine): {renderer} / {version}",
                         "VBO environment comparison: complete", "| 1 | 4052 | observed |"):
            self.assertIn(expected, summary)
        self.assertIn("API 34: render-mode evidence from the native GL pixel test is missing", problems)
        self.assertIn("API 34: system log reports a BattleCity ANR", problems)
        self.assertIn("**NOT ACCEPTED**", summary)

        # A renderer and version written by different contexts cannot supply a pair.
        for invalid in (render_line + version_line.replace("3150", "3151"),
                        render_line + version_line.replace("2986", "2987"),
                        render_line.replace("Google SwiftShader", "ANGLE (SwiftShader)") + version_line,
                        render_line + version_line.replace("SwiftShader 4.0.0.1", "ANGLE"),
                        render_line + version_line + render_line.replace("Google SwiftShader", "llvmpipe") + version_line):
            log.write_text(invalid)
            self.assertIn("VBO environment comparison: unavailable", self.evaluate(device_status="failure")[0])

        log.write_text(render_line + version_line)
        self.write_render_evidence("34", renderer="ANGLE (SwiftShader)")
        self.assertIn("VBO environment comparison: unavailable", self.evaluate(device_status="failure")[0])

    def test_other_logs_and_other_platform_cannot_replace_native_gl_evidence(self):
        path = self.write_render_evidence("34")
        other = self.build / "diagnostics/api-34/device-logcat.txt"
        other.parent.mkdir(parents=True, exist_ok=True)
        other.write_text(path.read_text())
        path.unlink()
        self.assertTrue(self.evaluate()[1])

    def case_log(self, api, case, text):
        path = self.build / f"outputs/androidTest-results/api-{api}/debug/fixture/logcat-org.jiangc.bc.TvLifecycleTest-{case}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    @staticmethod
    def progress_record(case, **changes):
        record = dict(test="org.jiangc.bc.TvLifecycleTest#" + case, activity="Level1Activity@fixture",
                      uptimeMillis=10_000, phase="record return", event="timeout",
                      engine=dict(sampleUptimeMillis=9_000, ageMillis=1_000, frames=80, screen="HISCORE",
                                  elapsed=400, explicitlyPaused=False, running=True,
                                  lastAdvanceUptimeMillis=9_000, frameSeconds=.05),
                      ui=dict(sampleUptimeMillis=6_000, ageMillis=4_000, foreground=True, focused=True,
                              finishing=False, destroyed=False))
        record.update(changes)
        return record

    def test_assertion_snapshot_is_preferred_to_later_teardown_and_does_not_hide_failure(self):
        case = results.PRESENTATION_CASES[0]
        first = self.progress_record(case)
        later = self.progress_record(case, uptimeMillis=11_000, event="sample", phase="teardown")
        later["engine"].update(screen="DONE", elapsed=0)
        self.case_log("34", case, "\n".join("BATTLECITY_PRESENTATION_PROGRESS " + json.dumps(r) for r in (first, later)))
        path = self.write_report(results.GROUPS[1][1], 46, "failure")
        root = ET.parse(path)
        root.getroot().find("testcase").set("name", case)
        root.write(path)
        summary, problems = self.evaluate()
        self.assertTrue(problems)
        self.assertIn("**NOT ACCEPTED**", summary)
        self.assertIn(f"API 34 / {case} | FAILURE", summary)
        self.assertIn("HISCORE elapsed=400, updates=80", summary)
        self.assertIn("engine sample age=1000ms", summary)
        self.assertIn("UI sample age=4000ms", summary)
        self.assertNotIn("phase=teardown", summary)
        self.assertIn("cause unconfirmed", summary)

    def test_missing_invalid_or_wrong_case_progress_stays_informational(self):
        case = results.PRESENTATION_CASES[0]
        invalid_engine = self.progress_record(case)
        invalid_engine["engine"]["frames"] = True
        invalid_ui = self.progress_record(case)
        invalid_ui["ui"]["focused"] = "true"
        for content in ("", "{bad", json.dumps(invalid_engine), json.dumps(invalid_ui),
                        json.dumps(self.progress_record("anotherCase"))):
            with self.subTest(content=content):
                self.case_log("34", case, "BATTLECITY_PRESENTATION_PROGRESS " + content)
                summary, problems = self.evaluate()
                self.assertFalse(problems)
                self.assertIn("Evidence insufficient", summary)
                self.assertIn("cause unconfirmed", summary)

    def test_missing_engine_or_ui_samples_are_reported_without_assuming_a_cause(self):
        case = results.PRESENTATION_CASES[1]
        self.case_log("34", case, "BATTLECITY_PRESENTATION_PROGRESS " + json.dumps(
            self.progress_record(case, engine=None, ui=None)))
        summary, problems = self.evaluate()
        self.assertFalse(problems)
        self.assertIn("engine sample unavailable", summary)
        self.assertIn("UI sample unavailable", summary)

    def test_vbo_waits_are_grouped_by_test_and_sample_and_keep_passing_outcomes(self):
        case = "soloUsesBoundControllerAndLifecycleKeepsPause"
        path = self.write_report(results.GROUPS[1][1], 46)
        root = ET.parse(path)
        root.getroot().find("testcase").set("name", case)
        root.write(path)
        lines = []
        for number, waiting in ((1, 2_100), (2, 4_100)):
            prefix = f"watchdog test=org.jiangc.bc.TvLifecycleTest#{case} sample={number} heartbeat=8 stallSample={number} | "
            lines += [prefix + f"phase=background waitingMillis={waiting}",
                      prefix + "at com.google.android.gles_jni.GLImpl.glGenBuffers(Native Method)",
                      prefix + "at org.anddev.andengine.opengl.view.GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)"]
        self.case_log("34", case, "\n".join(lines + lines))
        summary, problems = self.evaluate()
        self.assertFalse(problems)
        self.assertIn(f"API 34 / {case} | PASS | 2 | 4100", summary)
        self.assertIn("VBO stability remains pending", summary)

    def test_stacks_from_different_samples_or_tests_cannot_form_a_vbo_wait(self):
        case = "fixture"
        prefix = "watchdog test=Fixture#fixture sample=1 heartbeat=1 stallSample=1 | "
        self.case_log("34", case, "\n".join((prefix + "waitingMillis=4100",
            prefix + "at com.google.android.gles_jni.GLImpl.glGenBuffers(Native Method)",
            prefix.replace("sample=1", "sample=2") + "at GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)",
            prefix.replace("heartbeat=1", "heartbeat=2") + "at GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)",
            prefix.replace("Fixture#fixture", "Fixture#other") + "at GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)")))
        self.assertEqual({}, results.read_vbo_stalls(self.build / "outputs/androidTest-results/api-34"))

    def test_diagnostic_outcomes_preserve_skipped_and_duplicate_failures(self):
        directory = self.build / results.GROUPS[1][1]
        (directory / 'TEST-a.xml').write_text('<testsuite><testcase name="record"><failure/></testcase>'
                                            '<testcase name="notStarted" status="notrun"/></testsuite>')
        (directory / 'TEST-z.xml').write_text('<testsuite><testcase name="record"/></testsuite>')
        outcomes = results.case_outcomes(directory)
        self.assertEqual("FAILURE", outcomes["record"])
        self.assertEqual("SKIPPED", outcomes["notStarted"])

    def test_invalid_tv_mode_cannot_report_success(self):
        self.assertTrue(self.evaluate(tv_vbo_mode="automatic")[1])

    def paired_fixtures(self, reproduce=True):
        manifest = "".join(
            f"{hashlib.sha256((self.build / 'outputs/apk' / file).read_bytes()).hexdigest()}  build/outputs/apk/{file}\n"
            for _, file in results.APK_FILES
        )
        (self.build / "diagnostics/apks-built.sha256").write_text(manifest)
        statuses = {name: "success" for name in results.ROUND_NAMES}
        for name in results.ROUND_NAMES:
            self.write_report(results.DEVICE_RESULTS + "/" + name, 46)
            self.write_render_evidence("34", "default" if name == "baseline" else "disabled", round_name=name)
            host = self.build / "diagnostics/emulator-api-34" / name
            host.mkdir(parents=True)
            (host / "host-startup.txt").write_text("INFO | Android emulator version 37.3.10.0 (build_id 16970787)\n")
            (host / "image.properties").write_text("Pkg.Revision=3\n")
            device = self.build / "diagnostics/api-34" / name
            device.mkdir(parents=True)
            (device / "runner-started").touch()
            (device / "preflight.txt").write_text("Logcat exit status: 0\n")
            (device / "device-logcat.txt").write_text("I TestRunner: finished\n")
            (device / "device-fingerprint.txt").write_text(
                "adb shell getprop ro.build.fingerprint (exit 0):\ngoogle/tv/tv:14/BUILD/1234:user/release-keys\n")
            for phase in ("before", "after"):
                (device / f"apks-{phase}.sha256").write_text(manifest)
        if reproduce:
            statuses["baseline"] = "failure"
            sample = "watchdog test=org.jiangc.bc.TvMenuFlowTest#fixture sample=2 heartbeat=14 stallSample=2 | "
            (self.build / "diagnostics/api-34/baseline/device-logcat.txt").write_text(
                "\n".join(sample + detail for detail in (
                    "phase=teardown waitingMillis=4052",
                    "at GLImpl.glGenBuffers(Native Method)",
                    "at BufferObject.loadToHardware(BufferObject.java:93)",
                    "at GLSurfaceView$GLThread.requestExitAndWait(GLSurfaceView.java:718)",
                )) + "\nWindowManager: ANR in Window{abc u0 org.jiangc.bc/.Level1Activity}\n")
        return statuses

    def test_paired_repeats_are_automatic_and_a_candidate_does_not_pass_production(self):
        statuses = self.paired_fixtures()
        for completed in (1, 2):
            self.assertTrue(results.comparison_progress(self.build, statuses, completed))
        summary, problems = results.evaluate(self.build, "success", "unused", "fixture", rounds=statuses)
        self.assertIn("API 34: system log reports a BattleCity ANR", problems)
        self.assertIn("**NOT ACCEPTED**", summary)
        self.assertIn("candidate for physical TV validation", summary)
        self.assertIn("Matched VBO diagnostic passes: **3/3**", summary)

    def test_paired_missing_or_different_environment_stops_further_rounds(self):
        statuses = self.paired_fixtures()
        for relative, value, field in (
            ("emulator-api-34/comparison-1/image.properties", "Pkg.Revision=4\n", "TV image revision"),
            ("emulator-api-34/comparison-1/host-startup.txt",
             "INFO | Android emulator version 37.3.10.0 (build_id 16970788)\n", "Emulator version"),
            ("api-34/comparison-1/device-fingerprint.txt", "", "Environment evidence unavailable"),
        ):
            path = self.build / "diagnostics" / relative
            original = path.read_text()
            with self.subTest(field=field):
                path.write_text(value)
                self.assertFalse(results.comparison_progress(self.build, statuses, 1))
                self.assertIn(field, "\n".join(results.paired_report(self.build, statuses)[0]))
                path.write_text(original)
        self.write_render_evidence("34", "disabled", round_name="comparison-1", version="Other GLES build")
        self.assertFalse(results.comparison_progress(self.build, statuses, 1))
        self.assertIn("**Environment differs from baseline: GL version**", results.paired_report(self.build, statuses)[0])

    def test_failed_first_or_second_diagnostic_cannot_schedule_another_round(self):
        statuses = self.paired_fixtures()
        for name, completed in (("comparison-1", 1), ("comparison-2", 2)):
            with self.subTest(name=name):
                statuses[name] = "failure"
                self.assertFalse(results.comparison_progress(self.build, statuses, completed))
                statuses[name] = "success"

    def test_clean_baseline_stops_repeats_and_keeps_its_own_acceptance(self):
        statuses = self.paired_fixtures(reproduce=False)
        statuses.update({"comparison-1": "failure", "comparison-2": "skipped", "comparison-3": "skipped"})
        self.assertFalse(results.comparison_progress(self.build, statuses, 1))
        summary, problems = results.evaluate(self.build, "success", "unused", "fixture", rounds=statuses)
        self.assertEqual([], problems)
        self.assertIn("**Diagnostic checks failed**", summary)
        self.assertIn("**PASSED**", summary)
        self.assertEqual(2, summary.count("**Not run**"))

    def test_changed_apk_in_any_round_invalidates_the_shared_build(self):
        statuses = self.paired_fixtures(reproduce=False)
        changed = self.build / "diagnostics/api-34/comparison-1/apks-after.sha256"
        changed.write_text("recorded different bytes")
        summary, problems = results.evaluate(self.build, "success", "unused", "fixture", rounds=statuses)
        self.assertIn("VBO diagnostic used APKs that differ from the initial build", problems)
        self.assertIn("**NOT ACCEPTED**", summary)
        _, relative = results.APK_FILES[0]
        (self.build / "outputs/apk" / relative).write_text("changed final APK")
        _, problems = results.evaluate(self.build, "success", "unused", "fixture", rounds=statuses)
        self.assertIn("Final APKs do not match the build-time SHA-256 manifest", problems)

    def test_failed_boot_with_no_guest_results_reports_adb_evidence_and_counts_no_baseline(self):
        statuses = self.paired_fixtures(reproduce=False)
        statuses.update({"baseline": "failure", "comparison-2": "skipped", "comparison-3": "skipped"})
        (self.build / results.DEVICE_RESULTS / "baseline/TEST-fixture.xml").unlink()
        diagnostics = self.build / "diagnostics/api-34/baseline"
        for path in diagnostics.iterdir():
            path.unlink()
        host = self.build / "diagnostics/emulator-api-34/baseline"
        (host / "adb-startup.txt").write_text("emulator-5554 unauthorized")
        self.assertFalse(results.comparison_progress(self.build, statuses, 1))
        summary, problems = results.evaluate(self.build, "success", "unused", "fixture", rounds=statuses)
        self.assertTrue(problems)
        self.assertIn("Device test script: not started", summary)
        self.assertIn("ADB startup status: diagnostics/emulator-api-34/baseline/adb-startup.txt", summary)
        self.assertIn("expected at least 46 tests, found 0", summary)
        self.assertIn("VBO diagnostic passes: **0/3**", summary)

    def test_signature_failure_cannot_leave_a_diagnostic_success_heading(self):
        with mock.patch.object(results, "Path", return_value=self.build), \
             mock.patch.object(results, "evaluate", return_value=(results.DIAGNOSTIC_SUCCESS, [])), \
             mock.patch.object(results, "verify_apks", return_value=("Signatures failed", ["fixture failure"])), \
             mock.patch.object(results.argparse.ArgumentParser, "parse_args",
                               return_value=Namespace(local=False, paired=False, comparison_progress=None)), \
             mock.patch.dict(results.os.environ, {"GITHUB_STEP_SUMMARY": ""}), \
             mock.patch("builtins.print"):
            self.assertEqual(1, results.main())
        summary = (self.build / "reports/android-acceptance.md").read_text()
        self.assertIn("**NOT ACCEPTED**", summary)
        self.assertNotIn(results.DIAGNOSTIC_SUCCESS, summary)

    def test_local_mode_never_claims_device_acceptance(self):
        for _, relative, _ in results.GROUPS[1:]:
            (self.build / relative / "TEST-fixture.xml").unlink()
        summary, problems = results.evaluate(self.build, "success", "not run", "workspace", local=True)
        self.assertEqual([], problems)
        self.assertIn("Device tests: **NOT RUN**", summary)
        self.assertIn("device validation pending", summary)
        self.assertTrue(results.evaluate(self.build, "success", "not run", "workspace")[1])
        self.assertTrue(results.evaluate(self.build, "failure", "not run", "workspace", local=True)[1])

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

    def test_device_step_must_succeed(self):
        for status in ("failure", "skipped", "cancelled", "not run"):
            with self.subTest(status=status):
                self.assertTrue(self.evaluate(device_status=status)[1])

    def test_unseparated_reports_cannot_replace_a_missing_platform(self):
        self.write_report("outputs/androidTest-results/connected", 100)
        for _, relative, minimum in results.GROUPS[1:]:
            with self.subTest(relative=relative):
                (self.build / relative / "TEST-fixture.xml").unlink()
                self.assertTrue(self.evaluate()[1])
                self.write_report(relative, minimum)

    def test_api36_results_cannot_replace_api34_tv(self):
        self.write_report("outputs/androidTest-results/api-36", 46)
        self.write_render_evidence("36")
        (self.build / results.DEVICE_RESULTS / "TEST-fixture.xml").unlink()
        self.write_render_evidence("34").unlink()
        summary, problems = self.evaluate()
        self.assertTrue(problems)
        self.assertIn("API 34 TV / 4K display / 1080p window: JUnit XML reports are missing", summary)
        self.assertIn("API 34: render-mode evidence from the native GL pixel test is missing", summary)
        self.assertNotIn("API 36", summary)

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
        self.assertIn(f"| API 34 TV / 4K display / 1080p window | {count} | 0 | 0 | 0 |", summary)


if __name__ == "__main__":
    unittest.main()
