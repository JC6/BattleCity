#!/usr/bin/env python3
"""Require real JUnit results for the repository-derived Android build. Standard library only."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import os
from pathlib import Path
from typing import NamedTuple
import xml.etree.ElementTree as ET


GROUPS = (
    ("JVM", "test-results/testDebugUnitTest", 173),
    ("API 34 TV / 4K display / 1080p window", "outputs/androidTest-results/api-34", 46),
)
DEVICE_RESULTS = GROUPS[1][1]
APK_FILES = (
    ("APK", "debug/BattleCity-debug.apk"),
    ("Instrumentation APK", "androidTest/debug/BattleCity-debug-androidTest.apk"),
)
ROUND_NAMES = ("baseline", "comparison-1", "comparison-2", "comparison-3")
ROUND_LABELS = dict(zip(ROUND_NAMES, ("Production baseline", "VBO diagnostic", "VBO diagnostic repeat 1", "VBO diagnostic repeat 2")))
PRESENTATION_CASES = (
    "highScoreDisconnectFreezesPresentationAndFinishesOnce",
    "constructionSelectedStageAndRecordReturnToOriginalMenu",
    "startSkipsGameOverButPreservesNewRecordPresentation",
)
DIAGNOSTIC_SUCCESS = "**DIAGNOSTIC CHECKS PASSED — production acceptance pending**"


def read_results(directory):
    counts = dict(tests=0, failures=0, errors=0, skipped=0)
    problems = []
    reports = sorted(directory.rglob("TEST-*.xml"))
    if not reports:
        problems.append("JUnit XML reports are missing")
    for report in reports:
        try:
            root = ET.parse(report).getroot()
            if root.tag not in ("testsuite", "testsuites"):
                raise ValueError("not a JUnit test suite")
            # Count leaf suites only; a testsuites wrapper may also contain aggregate totals.
            suites = [suite for suite in root.iter("testsuite") if not suite.findall("testsuite")]
            if not suites:
                raise ValueError("no test suites")
            for suite in suites:
                cases = suite.findall("testcase")
                declared = {key: int(suite.get(key, "0")) for key in counts}
                if any(value < 0 for value in declared.values()):
                    raise ValueError("negative test counts")
                if "tests" in suite.attrib and declared["tests"] != len(cases):
                    raise ValueError("test count does not match testcase records")
                counts["tests"] += len(cases)
                for key, tag in (("failures", "failure"), ("errors", "error"), ("skipped", "skipped")):
                    actual = sum(case.find(tag) is not None or (
                        key == "skipped" and case.get("status") in ("skipped", "notrun")
                    ) for case in cases)
                    # A crashed runner can report a suite-level error without a testcase element.
                    counts[key] += max(actual, declared[key])
        except (OSError, ET.ParseError, ValueError) as failure:
            problems.append(f"{report.name}: {failure}")
    return counts, problems


def swiftshader_gles(renderer, version):
    renderer = renderer.casefold()
    return "swiftshader" in renderer and "angle" not in renderer and "angle" not in version.casefold()


def read_render_evidence(directory, expected):
    records, problems, observed_gl = [], [], set()
    marker = "BATTLECITY_RENDER_MODE "
    for path in sorted(directory.rglob("logcat-*TvMenuFlowTest-actualGlAdapterMatchesSoftwareAcrossSpriteSizesAndPausedScreens.txt")):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if marker not in line:
                    continue
                record = json.loads(line.split(marker, 1)[1])
                has_gl = isinstance(record, dict) and all(
                    isinstance(record.get(key), str) and record[key].strip() for key in ("renderer", "version")
                )
                if has_gl:
                    observed_gl.add((record["renderer"].strip(), record["version"].strip()))
                if (not has_gl or type(record.get("api")) is not int
                        or record["api"] != 34 or record.get("requested") != expected
                        or type(record.get("activeVbo")) is not bool
                        or type(record.get("optionsDisabled")) is not bool
                        or record["activeVbo"] != (expected == "default")
                        or record["optionsDisabled"] != (expected == "disabled")):
                    raise ValueError("API, requested mode, engine options or actual GL state do not match")
                if not swiftshader_gles(record["renderer"], record["version"]):
                    raise ValueError(f"expected SwiftShader GLES renderer, detected {record['renderer']} / {record['version']}")
                dimensions = ("displayWidth", "displayHeight", "windowWidth", "windowHeight",
                              "surfaceWidth", "surfaceHeight", "scale")
                if any(type(record.get(key)) is not int for key in dimensions):
                    raise ValueError("display, window, surface and integer scale evidence is required")
                if (record["displayWidth"], record["displayHeight"], record["windowWidth"], record["windowHeight"]) != (3840, 2160, 1920, 1080):
                    raise ValueError("API 34 requires a 3840x2160 display and a 1920x1080 window")
                scale = record["scale"]
                if (scale < 1 or record["surfaceWidth"] != 256 * scale or record["surfaceHeight"] != 240 * scale
                        or record["surfaceWidth"] > record["windowWidth"] or record["surfaceHeight"] > record["windowHeight"]):
                    raise ValueError("the surface must fit the window at an integer 256x240 scale")
                records.append(record)
        except (OSError, ValueError, TypeError) as failure:
            problems.append(f"{path.name}: invalid render-mode evidence ({failure})")
    if not records:
        problems.append("render-mode evidence from the native GL pixel test is missing")
    return records, problems, observed_gl


def case_outcomes(directory):
    outcomes = {}
    rank = {"PASS": 0, "SKIPPED": 1, "FAILURE": 2, "ERROR": 3}
    for path in sorted(directory.rglob("TEST-*.xml")):
        try:
            for case in ET.parse(path).getroot().iter("testcase"):
                outcome = next((tag.upper() for tag in ("error", "failure", "skipped")
                    if case.find(tag) is not None), "SKIPPED" if case.get("status") in ("skipped", "notrun") else "PASS")
                name = case.get("name")
                if rank[outcome] >= rank[outcomes.get(name, "PASS")]:
                    outcomes[name] = outcome
        except (OSError, ET.ParseError):
            continue  # The acceptance gate reports invalid JUnit independently.
    return outcomes


def read_case_progress(directory, case):
    records, notes = [], []
    marker = "BATTLECITY_PRESENTATION_PROGRESS "
    for path in sorted(directory.rglob(f"logcat-*-{case}.txt")):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if marker not in line:
                    continue
                try:
                    record = json.loads(line.split(marker, 1)[1])
                    if (not isinstance(record, dict) or not isinstance(record.get("test"), str)
                            or not record["test"].endswith("#" + case)
                            or any(not isinstance(record.get(key), str) or not record[key] for key in ("activity", "phase"))
                            or record.get("event") not in ("sample", "timeout", "watchdog")
                            or type(record.get("uptimeMillis")) is not int or record["uptimeMillis"] < 0):
                        raise ValueError("invalid progress identity or time")
                    for part, numbers, flags in (
                        ("engine", ("frames", "elapsed", "lastAdvanceUptimeMillis"), ("explicitlyPaused", "running")),
                        ("ui", (), ("foreground", "focused", "finishing", "destroyed")),
                    ):
                        sample = record.get(part)
                        if sample is None:
                            continue
                        if (not isinstance(sample, dict)
                                or any(type(sample.get(key)) is not int or sample[key] < 0
                                       for key in ("sampleUptimeMillis", "ageMillis", *numbers))
                                or sample["sampleUptimeMillis"] > record["uptimeMillis"]
                                or any(type(sample.get(key)) is not bool for key in flags)
                                or (part == "engine" and sample.get("screen") not in
                                    ("BATTLE", "SCORE", "GAME_OVER", "HISCORE", "DONE"))):
                            raise ValueError(f"invalid {part} snapshot")
                    records.append(record)
                except (ValueError, TypeError) as failure:
                    notes.append(f"Invalid progress evidence: {failure}")
        except OSError as failure:
            notes.append(f"Could not read progress evidence: {failure}")
    return records, notes


def read_vbo_stalls(directory, device_log=None):
    samples = {}
    pattern = re.compile(r"watchdog test=(\S+) sample=(\d+) heartbeat=(\d+) stallSample=\d+")
    paths = sorted(directory.rglob("logcat-*.txt"))
    if device_log is not None:
        paths.append(device_log)
    for path in paths:
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                match = pattern.search(line)
                if not match:
                    continue
                sample = samples.setdefault(match.groups(), dict(wait=0, allocation=False, exit=False, hardware=False))
                waiting = re.search(r"\bwaitingMillis=(\d+)\b", line)
                if waiting:
                    sample["wait"] = max(sample["wait"], int(waiting[1]))
                sample["allocation"] |= "GLImpl.glGenBuffers(" in line
                sample["exit"] |= "GLThread.requestExitAndWait(" in line
                sample["hardware"] |= "BufferObject.loadToHardware(" in line
        except OSError:
            continue
    stalls = {}
    for (test, _, _), sample in samples.items():
        if not sample["allocation"] or not sample["exit"] or sample["wait"] < 2_000:
            continue
        case = test.rsplit("#", 1)[-1]
        count, waiting, hardware = stalls.get(case, (0, 0, False))
        stalls[case] = count + 1, max(waiting, sample["wait"]), hardware or sample["hardware"]
    return stalls


APP_ANR = re.compile(
    r"\b(?:WindowManager: ANR in Window\{[^}]*\sorg\.jiangc\.bc/[^}]+\}"
    r"|ActivityManager: ANR in org\.jiangc\.bc(?=\s|\(|$))"
)


def check_application_anrs(directory, device_status):
    lines, problems = ["", "Application ANR checks:", ""], []
    try:
        log = (directory / "device-logcat.txt").read_text(encoding="utf-8", errors="replace")
    except OSError:
        log = ""
    try:
        preflight = (directory / "preflight.txt").read_text(encoding="utf-8", errors="replace")
    except OSError:
        preflight = ""
    matches = [line for line in log.splitlines() if APP_ANR.search(line)]
    if matches:
        problems.append("API 34: system log reports a BattleCity ANR")
        lines.extend(["- API 34: BattleCity ANR recorded", "", "```text", *matches, "```", ""])
    elif not log.strip() or re.findall(r"^Logcat exit status: (\d+)$", preflight, re.MULTILINE) != ["0"]:
        lines.append("- API 34: system log unavailable or incomplete")
        if device_status == "success":
            problems.append("API 34: complete system log required for ANR verification")
    else:
        lines.append("- API 34: no BattleCity ANR recorded")
    return lines, problems, bool(matches)


def diagnostic_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def read_image_revision(host):
    properties = diagnostic_text(host / "image.properties")
    match = re.search(r"^Pkg\.Revision[ \t]*=[ \t]*(\d+(?:\.\d+){0,2})[ \t]*$", properties, re.MULTILINE)
    if match:
        return match[1].removesuffix(".0").removesuffix(".0")
    try:
        package = ET.parse(host / "image-package.xml").find(
            ".//{*}localPackage[@path='system-images;android-34;android-tv;x86']/{*}revision")
    except (OSError, ET.ParseError):
        return ""
    if package is None:
        return ""
    parts = [package.findtext(f"{{*}}{part}", default).strip()
             for part, default in (("major", ""), ("minor", "0"), ("micro", "0"))]
    if not all(re.fullmatch(r"\d+", part) for part in parts):
        return ""
    return ".".join(parts).removesuffix(".0").removesuffix(".0")


def read_andengine_gl(device_log):
    pattern = re.compile(
        r"^\d\d-\d\d[ \t]+\d\d:\d\d:\d\d\.\d+[ \t]+(\d+)[ \t]+(\d+)[ \t]+[A-Z][ \t]+"
        r"AndEngine[ \t]*:[ \t]*(RENDERER|VERSION):[ \t]*(\S.*)$"
    )
    pending, pairs = {}, set()
    try:
        with device_log.open(encoding="utf-8", errors="replace") as log:
            for line in log:
                match = pattern.match(line)
                if match is None:
                    continue
                pid, tid, key, value = match.groups()
                context = pending.setdefault((pid, tid), {})
                context[key] = value.strip()
                if "RENDERER" in context and "VERSION" in context:
                    pairs.add((context["RENDERER"], context["VERSION"]))
                    del pending[(pid, tid)]
    except OSError:
        return set()
    return pairs


def emulator_summary(build_dir, native_gl, round_name):
    diagnostics = build_dir / "diagnostics"
    host = diagnostics / "emulator-api-34" / round_name
    device = diagnostics / "api-34" / round_name
    host_log = host / "host-startup.txt"
    started = (device / "runner-started").is_file()
    version = re.search(r"^.*Android emulator version[ \t]+(\S+[ \t]+\(build_id[ \t]+\d+\))",
                        diagnostic_text(host_log), re.MULTILINE)
    revision = read_image_revision(host)
    fingerprint = re.search(r"^adb shell getprop ro\.build\.fingerprint \(exit 0\):\n(\S+/\S+:\S+)$",
                            diagnostic_text(device / "device-fingerprint.txt"), re.MULTILINE)
    andengine_gl = read_andengine_gl(device / "device-logcat.txt")
    observed_gl = native_gl | andengine_gl
    incomplete = []
    lines = ["", "Emulator evidence:", "", f"- Device test script: {'started' if started else 'not started'}"]
    identity = dict((("Emulator version", version[1] if version else ""),
                         ("TV image revision", revision),
                         ("Device build fingerprint", fingerprint[1] if fingerprint else "")))
    for label, value in identity.items():
        lines.append(f"- {label}: {value or 'unavailable'}")
        if not value:
            incomplete.append(label)
    if not started:
        incomplete.append("device test script did not start")
    lines.extend(f"- Device GL (AndEngine): {renderer} / {gl_version}" for renderer, gl_version in sorted(andengine_gl))
    if len(observed_gl) != 1 or not any(swiftshader_gles(*pair) for pair in observed_gl):
        incomplete.append("missing, conflicting or non-SwiftShader device GL evidence")
    else:
        identity["GL renderer"], identity["GL version"] = next(iter(observed_gl))
    if incomplete:
        lines.append("- VBO environment comparison: unavailable (" + ", ".join(incomplete) + ")")
    else:
        lines.append("- VBO environment comparison: complete")
    if host_log.is_file():
        lines.append(f"- Host startup output: {host_log.relative_to(build_dir)}")
    if (host / "adb-startup.txt").is_file():
        lines.append(f"- ADB startup status: {(host / 'adb-startup.txt').relative_to(build_dir)}")
    if (device / "boot-logcat.txt").is_file():
        lines.append(f"- Device boot log: {(device / 'boot-logcat.txt').relative_to(build_dir)}")
    return lines, None if incomplete else identity


def diagnostic_summary(directory, stalls):
    lines = ["", "Presentation progress (30-second automatic return budget):", "",
             "| Platform / case | JUnit outcome | Latest progress |",
             "|---|---|---|"]
    vbo = []
    outcomes = case_outcomes(directory)
    for case in PRESENTATION_CASES:
        records, notes = read_case_progress(directory, case)
        # Prefer the assertion-time snapshot over teardown observations after a failure.
        candidates = [record for record in records if record["event"] == "timeout"] or records
        if not candidates:
            detail = "Evidence insufficient: no valid progress snapshots; cause unconfirmed"
        else:
            last = max(candidates, key=lambda record: record["uptimeMillis"])
            e, u = last.get("engine"), last.get("ui")
            detail = f"{last['event']}; phase={last['phase']}"
            if e is None:
                detail += "; engine sample unavailable"
            else:
                detail += (f"; {e['screen']} elapsed={e['elapsed']}, updates={e['frames']}, "
                           f"paused={str(e['explicitlyPaused']).lower()}, running={str(e['running']).lower()}, "
                           f"engine sample age={e['ageMillis']}ms, last advance uptime={e['lastAdvanceUptimeMillis']}ms")
            if u is None:
                detail += "; UI sample unavailable"
            else:
                detail += "; " + ", ".join(f"{key}={str(u[key]).lower()}" for key in
                                            ("foreground", "focused", "finishing", "destroyed"))
                detail += f", UI sample age={u['ageMillis']}ms"
            detail += "; cause unconfirmed"
        if notes:
            detail += "; " + "; ".join(sorted(set(notes)))
        detail = detail.replace("|", "\\|").replace("\n", " ").replace("\r", " ")
        lines.append(f"| API 34 / {case} | {outcomes.get(case, 'not recorded')} | {detail} |")
    for case, (count, waiting, hardware) in sorted(stalls.items()):
        vbo.append(f"| API 34 / {case} | {outcomes.get(case, 'not recorded')} | {count} | {waiting} | "
                   f"{'observed' if hardware else 'unconfirmed'} |")
    lines.extend(["", "VBO lifecycle wait observations (separate from presentation timeouts):", "",
                  "| Platform / case | JUnit outcome | Matching stack samples | Longest sampled wait ms | VBO buffer upload |",
                  "|---|---|---:|---:|---|", *vbo])
    lines.extend(["", "VBO stability remains pending physical TV validation. "
                  "A passing JUnit outcome can coexist with a long GL lifecycle wait; observations do not establish a system ANR."])
    return lines


def suite_summary(directory, label, minimum):
    counts, errors = read_results(directory)
    row = f"| {label} | {counts['tests']} | {counts['failures']} | {counts['errors']} | {counts['skipped']} |"
    problems = [f"{label}: {error}" for error in errors]
    if counts["tests"] < minimum:
        problems.append(f"{label}: expected at least {minimum} tests, found {counts['tests']}")
    if any(counts[key] for key in ("failures", "errors", "skipped")):
        problems.append(f"{label}: failures, errors and skipped tests must all be zero")
    return row, problems


class DeviceRound(NamedTuple):
    lines: list
    problems: list
    environment: dict | None
    reproduced: bool
    stalled: bool
    apk_verified: bool
    apk_mismatch: bool


def device_round(build_dir, status, mode, round_name=""):
    label, relative, minimum = GROUPS[1]
    directory = build_dir / relative / round_name
    diagnostics = build_dir / "diagnostics/api-34" / round_name
    row, problems = suite_summary(directory, label, minimum)
    lines = [f"API 34 Android TV / x86 / 4K display / 1080p window test command: **{status}**",
             f"Requested render mode: **{mode}**.", "",
             "| Suite | Tests | Failures | Errors | Skipped |", "|---|---:|---:|---:|---:|", row]
    if status != "success":
        problems.append(f"API 34 device tests did not succeed ({status})")
    lines.extend(["", "| Platform | Requested mode | Active VBO | GL renderer | GL version | Display px | Window px | Surface px | Scale |",
                  "|---|---|---|---|---|---|---|---|---|"])
    records, errors, native_gl = read_render_evidence(directory, mode)
    problems.extend(f"API 34: {error}" for error in errors)
    for record in records:
        renderer = record["renderer"].replace("|", "\\|").replace("\n", " ")
        gl_version = record["version"].replace("|", "\\|").replace("\n", " ")
        dimensions = [f"{record[prefix + 'Width']}x{record[prefix + 'Height']}" for prefix in ("display", "window", "surface")]
        lines.append(f"| API 34 | {mode} | {str(record['activeVbo']).lower()} | {renderer} | {gl_version} | "
                     + " | ".join(dimensions) + f" | {record['scale']} |")
    emulator_lines, environment = emulator_summary(build_dir, native_gl, round_name)
    lines.extend(emulator_lines)
    stalls = read_vbo_stalls(directory, diagnostics / "device-logcat.txt")
    lines.extend(diagnostic_summary(directory, stalls))
    anr_lines, anr_problems, anr = check_application_anrs(diagnostics, status)
    lines.extend(anr_lines)
    problems.extend(anr_problems)
    apk_verified, apk_mismatch = False, False
    if round_name:
        expected = diagnostic_text(build_dir / "diagnostics/apks-built.sha256")
        matched = 0
        for phase in ("before", "after"):
            digest_file = diagnostics / f"apks-{phase}.sha256"
            if not expected or not digest_file.is_file():
                problems.append(f"APK digest evidence unavailable {phase} device tests")
            elif diagnostic_text(digest_file) != expected:
                problems.append(f"APK digest changed {phase} device tests")
                apk_mismatch = True
            else:
                matched += 1
        apk_verified = matched == 2
        if apk_verified:
            lines.append("- Same APK digests verified before and after device tests")
    return DeviceRound(lines, problems, environment,
                       status == "failure" and anr and any(hardware for _, _, hardware in stalls.values()),
                       bool(stalls), apk_verified, apk_mismatch)


def comparison_problem(baseline, diagnostic):
    if baseline.environment is None or diagnostic.environment is None:
        return "Environment evidence unavailable"
    if not (baseline.apk_verified and diagnostic.apk_verified):
        return "Identical APKs could not be verified"
    differences = [key for key in baseline.environment if baseline.environment[key] != diagnostic.environment[key]]
    if differences:
        return "Environment differs from baseline: " + ", ".join(differences)
    if diagnostic.problems:
        return "Diagnostic checks failed"
    if diagnostic.stalled:
        return "GL lifecycle wait observed"
    return ""


def built_apks_match(build_dir):
    try:
        expected = "".join(
            f"{hashlib.sha256((build_dir / 'outputs/apk' / file).read_bytes()).hexdigest()}  build/outputs/apk/{file}\n"
            for _, file in APK_FILES
        )
    except OSError:
        return False
    return diagnostic_text(build_dir / "diagnostics/apks-built.sha256") == expected


def comparison_progress(build_dir, statuses, completed):
    baseline = device_round(build_dir, statuses["baseline"], "default", "baseline")
    if not baseline.reproduced or not baseline.apk_verified or not built_apks_match(build_dir):
        return False
    for name in ROUND_NAMES[1:completed + 1]:
        diagnostic = device_round(build_dir, statuses[name], "disabled", name)
        if comparison_problem(baseline, diagnostic):
            return False
    return True


def paired_report(build_dir, statuses):
    baseline = device_round(build_dir, statuses["baseline"], "default", "baseline")
    lines = ["", f"## {ROUND_LABELS['baseline']}", "", *baseline.lines]
    problems = list(baseline.problems)
    built_match = built_apks_match(build_dir)
    if not built_match:
        problems.append("Final APKs do not match the build-time SHA-256 manifest")
    passed = 0
    for name in ROUND_NAMES[1:]:
        if statuses[name] in ("skipped", "not run"):
            lines.extend(["", f"## {ROUND_LABELS[name]}", "", "**Not run**"])
            continue
        diagnostic = device_round(build_dir, statuses[name], "disabled", name)
        issue = comparison_problem(baseline, diagnostic)
        if not issue:
            passed += 1
        lines.extend(["", f"## {ROUND_LABELS[name]}", "", f"**{issue or 'Matched diagnostic passed'}**", "", *diagnostic.lines])
        lines.extend(f"- {problem}" for problem in diagnostic.problems)
        if diagnostic.apk_mismatch:
            problems.append(f"{ROUND_LABELS[name]} used APKs that differ from the initial build")
    lines.extend(["", f"Matched VBO diagnostic passes: **{passed}/3**."])
    if passed == 3 and baseline.reproduced and built_match:
        lines.append("**Disabling VBO is a candidate for physical TV validation.**")
    return lines, problems


def evaluate(build_dir, build_status, device_status, commit, local=False, tv_vbo_mode="default", rounds=None):
    problems = []
    if tv_vbo_mode not in ("default", "disabled"):
        problems.append("TV VBO mode must be default or disabled")
    lines = [
        "# Android TV framework validation", "", f"Commit: `{commit}`", "",
        "Data: **shared source-generated game data**; no external pack is required.",
        "These checks validate the adaptation and Android framework, not a complete pixel-exact original-game match.", "",
        f"Build / unit tests / lint: **{build_status}**", "",
        "| Suite | Tests | Failures | Errors | Skipped |",
        "|---|---:|---:|---:|---:|",
    ]
    if build_status != "success":
        problems.append(f"Build checks did not succeed ({build_status})")
    label, relative, minimum = GROUPS[0]
    row, errors = suite_summary(build_dir / relative, label, minimum)
    lines.append(row)
    problems.extend(errors)

    if local:
        lines.extend(["", "Device tests: **NOT RUN**. The instrumentation APK is compiled only; no emulator or physical device is contacted."])
    elif rounds is not None:
        round_lines, round_problems = paired_report(build_dir, rounds)
        lines.extend(round_lines)
        problems.extend(round_problems)
    else:
        device = device_round(build_dir, device_status, tv_vbo_mode)
        lines.extend(["", *device.lines])
        problems.extend(device.problems)
    lint = build_dir / "reports/lint-results-debug.xml"
    try:
        issues = ET.parse(lint).getroot().findall("issue")
        errors = sum(issue.get("severity") in ("Error", "Fatal") for issue in issues)
        warnings = sum(issue.get("severity") == "Warning" for issue in issues)
        lines.extend(["", f"Lint: **{errors} errors, {warnings} warnings**"])
        if errors: problems.append("Lint contains errors")
    except (OSError, ET.ParseError):
        problems.append("Lint XML report is missing or invalid")
    for label, relative in APK_FILES:
        try:
            data = (build_dir / "outputs/apk" / relative).read_bytes()
            if not data: raise ValueError("APK is empty")
            lines.extend(["", f"{label} SHA-256: `{hashlib.sha256(data).hexdigest()}`"])
        except (OSError, ValueError):
            problems.append(f"{label} is missing or empty")
    success = ("**LOCAL CHECKS PASSED — device validation pending**" if local else
               DIAGNOSTIC_SUCCESS if tv_vbo_mode == "disabled" else "**PASSED**")
    lines.extend(["", "**NOT ACCEPTED**" if problems else success, ""])
    lines.extend(f"- {problem}" for problem in problems)
    lines.extend(["", "No APK is published by this workflow. Tests use the same game resources as local builds and simulated controllers. Actual device firmware, "
                  "Bluetooth mappings, display and audio latency still require device checks.", ""])
    return "\n".join(lines), problems


def verify_apks(build_dir):
    diagnostics = build_dir / "diagnostics/apk-signatures"
    diagnostics.mkdir(parents=True, exist_ok=True)
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    candidates = list((Path(sdk) / "build-tools").glob("*/apksigner")) if sdk else []
    signer = max(candidates, key=lambda path: tuple(int(n) for n in re.findall(r"\d+", path.parent.name))) if candidates else shutil.which("apksigner")
    if not signer:
        (diagnostics / "tool.txt").write_text("apksigner was not found\n", encoding="utf-8")
        return "APK signatures: **NOT VERIFIED**", ["apksigner was not found; see diagnostics/apk-signatures/tool.txt"]
    try:
        version = subprocess.run([str(signer), "version"], capture_output=True, text=True)
        tool_details = (f"Tool: {signer}\nVersion exit code: {version.returncode}\n"
                        f"stdout:\n{version.stdout}\nstderr:\n{version.stderr}\n")
    except OSError as failure:
        tool_details = f"Tool: {signer}\nVersion could not be read: {failure}\n"
    (diagnostics / "tool.txt").write_text(tool_details, encoding="utf-8")
    problems = []
    certificates = []
    could_not_start = False
    for relative in ("debug/BattleCity-debug.apk", "androidTest/debug/BattleCity-debug-androidTest.apk"):
        apk = build_dir / "outputs/apk" / relative
        log = diagnostics / f"{apk.name}.txt"
        details = f"Tool: {signer}\nAPK: {apk}\n"
        try:
            run = subprocess.run([str(signer), "verify", "--print-certs", str(apk)],
                                 capture_output=True, text=True)
        except OSError as failure:
            log.write_text(details + f"Could not start apksigner: {failure}\n", encoding="utf-8")
            problems.append(f"apksigner could not be started for {relative}; see {log.relative_to(build_dir)}")
            could_not_start = True
            continue
        log.write_text(details + f"Exit code: {run.returncode}\nstdout:\n{run.stdout}\nstderr:\n{run.stderr}\n", encoding="utf-8")
        # Build Tools 37 prints "V2 Signer:" where older tools print "Signer #1".
        digests = re.findall(r"^(?:Signer #[1-9]\d*|V2 Signer:) certificate SHA-256 digest: ([^\r\n]*)\r?$",
                             run.stdout, re.MULTILINE)
        unique = {digest.lower() for digest in digests}
        if run.returncode or len(unique) != 1 or any(not re.fullmatch(r"[0-9a-fA-F]{64}", digest) for digest in digests):
            reason = f"exit code {run.returncode}" if run.returncode else "expected one unique valid signer certificate SHA-256 digest"
            problems.append(f"Signature verification failed: {relative} ({reason}); see {log.relative_to(build_dir)}")
            continue
        certificates.append(next(iter(unique)))
    if problems:
        status = "NOT VERIFIED" if could_not_start else "FAILED"
        return f"APK signatures: **{status}**; tool: `{signer}`", problems
    if certificates[0] != certificates[1]:
        return "APK signatures: **FAILED**", ["Application and instrumentation APK certificates differ"]
    return f"Both APK signatures verified; certificate SHA-256: `{certificates[0]}`", []


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--local", action="store_true", help="Check local build artifacts without requiring device results")
    mode.add_argument("--paired", action="store_true", help="Summarize production and diagnostic device rounds")
    mode.add_argument("--comparison-progress", type=int, choices=(1, 2), help="Decide whether to run the next diagnostic round")
    args = parser.parse_args()
    build_dir = Path("build")
    statuses = {name: os.environ.get(f"{name.upper().replace('-', '_')}_STATUS") or "not run" for name in ROUND_NAMES}
    if args.comparison_progress:
        repeat = comparison_progress(build_dir, statuses, args.comparison_progress)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"repeat={str(repeat).lower()}\n")
        return 0
    summary, problems = evaluate(
        build_dir, os.environ.get("BUILD_STATUS", "not run"),
        os.environ.get("DEVICE_API34_STATUS", "not run"),
        os.environ.get("GITHUB_SHA", "local workspace"), local=args.local,
        tv_vbo_mode=os.environ.get("BATTLECITY_TV_VBO_MODE", "default"),
        rounds=statuses if args.paired else None,
    )
    signatures, failures = verify_apks(build_dir)
    if failures and not problems:
        summary = summary.replace("**PASSED**", "**NOT ACCEPTED**").replace(
            "**LOCAL CHECKS PASSED — device validation pending**", "**NOT ACCEPTED**").replace(
            DIAGNOSTIC_SUCCESS, "**NOT ACCEPTED**")
    problems.extend(failures)
    summary += "\n" + signatures + "\n" + "".join(f"- {failure}\n" for failure in failures)
    report = build_dir / "reports/android-acceptance.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary)
    print(summary)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
