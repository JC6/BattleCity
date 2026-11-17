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
import xml.etree.ElementTree as ET


GROUPS = (
    ("JVM", "test-results/testDebugUnitTest", 173),
    ("API 34 TV / 4K display / 1080p window", "outputs/androidTest-results/api-34", 46),
    ("API 36 TV / 4K display / 4K window", "outputs/androidTest-results/api-36", 46),
)
WINDOWS = {"34": (1920, 1080), "36": (3840, 2160)}
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


def read_render_evidence(directory, expected, api):
    records, problems = [], []
    marker = "BATTLECITY_RENDER_MODE "
    for path in sorted(directory.rglob("logcat-*TvMenuFlowTest-actualGlAdapterMatchesSoftwareAcrossSpriteSizesAndPausedScreens.txt")):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if marker not in line:
                    continue
                record = json.loads(line.split(marker, 1)[1])
                if (not isinstance(record, dict) or type(record.get("api")) is not int
                        or record["api"] != int(api) or record.get("requested") != expected
                        or type(record.get("activeVbo")) is not bool
                        or type(record.get("optionsDisabled")) is not bool
                        or record["activeVbo"] != (expected == "default")
                        or record["optionsDisabled"] != (expected == "disabled")
                        or any(not isinstance(record.get(key), str) or not record[key].strip()
                               for key in ("renderer", "version"))):
                    raise ValueError("API, requested mode, engine options or actual GL state do not match")
                dimensions = ("displayWidth", "displayHeight", "windowWidth", "windowHeight",
                              "surfaceWidth", "surfaceHeight", "scale")
                if any(type(record.get(key)) is not int for key in dimensions):
                    raise ValueError("display, window, surface and integer scale evidence is required")
                if (record["displayWidth"], record["displayHeight"], record["windowWidth"], record["windowHeight"]) != (3840, 2160, *WINDOWS[api]):
                    raise ValueError(f"API {api} requires a 3840x2160 display and a {WINDOWS[api][0]}x{WINDOWS[api][1]} window")
                scale = record["scale"]
                if (scale < 1 or record["surfaceWidth"] != 256 * scale or record["surfaceHeight"] != 240 * scale
                        or record["surfaceWidth"] > record["windowWidth"] or record["surfaceHeight"] > record["windowHeight"]):
                    raise ValueError("the surface must fit the window at an integer 256x240 scale")
                records.append(record)
        except (OSError, ValueError, TypeError) as failure:
            problems.append(f"{path.name}: invalid render-mode evidence ({failure})")
    if not records:
        problems.append("render-mode evidence from the native GL pixel test is missing")
    return records, problems


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


def read_vbo_stalls(directory):
    samples = {}
    pattern = re.compile(r"watchdog test=(\S+) sample=(\d+) heartbeat=(\d+) stallSample=\d+")
    for path in sorted(directory.rglob("logcat-*.txt")):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                match = pattern.search(line)
                if not match:
                    continue
                sample = samples.setdefault(match.groups(), dict(wait=0, allocation=False, exit=False))
                waiting = re.search(r"\bwaitingMillis=(\d+)\b", line)
                if waiting:
                    sample["wait"] = max(sample["wait"], int(waiting[1]))
                sample["allocation"] |= "GLImpl.glGenBuffers(" in line
                sample["exit"] |= "GLThread.requestExitAndWait(" in line
        except OSError:
            continue
    stalls = {}
    for (test, _, _), sample in samples.items():
        if not sample["allocation"] or not sample["exit"] or sample["wait"] < 2_000:
            continue
        case = test.rsplit("#", 1)[-1]
        count, waiting = stalls.get(case, (0, 0))
        stalls[case] = count + 1, max(waiting, sample["wait"])
    return stalls


def diagnostic_summary(build_dir):
    lines = ["", "Presentation progress (diagnostic only; the 10-second assertions are unchanged):", "",
             "| Platform / case | JUnit outcome | Latest progress |",
             "|---|---|---|"]
    vbo = []
    for api in WINDOWS:
        directory = build_dir / f"outputs/androidTest-results/api-{api}"
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
            lines.append(f"| API {api} / {case} | {outcomes.get(case, 'not recorded')} | {detail} |")
        for case, (count, waiting) in sorted(read_vbo_stalls(directory).items()):
            vbo.append(f"| API {api} / {case} | {outcomes.get(case, 'not recorded')} | {count} | {waiting} |")
    lines.extend(["", "VBO lifecycle wait observations (separate from presentation timeouts):", "",
                  "| Platform / case | JUnit outcome | Matching stack samples | Longest sampled wait ms |",
                  "|---|---|---:|---:|", *vbo])
    lines.extend(["", "VBO stability remains pending comparison of independent default/disabled runs. "
                  "A passing JUnit outcome can coexist with a long GL lifecycle wait; observations do not establish a system ANR."])
    return lines


def evaluate(build_dir, build_status, device_statuses, commit, local=False, tv_vbo_mode="default"):
    problems = []
    if tv_vbo_mode not in ("default", "disabled"):
        problems.append("TV VBO mode must be default or disabled")
    lines = [
        "# Android TV framework validation", "", f"Commit: `{commit}`", "",
        "Data: **shared source-generated game data**; no external pack is required.",
        "These checks validate the adaptation and Android framework, not a complete pixel-exact original-game match.", "",
        f"Build / unit tests / lint: **{build_status}**",
        f"API 34 Android TV / x86 / 4K display / 1080p window test command: **{device_statuses.get('34', 'not run')}**",
        f"API 36 Android TV / x86_64 / 4K display / 4K window test command: **{device_statuses.get('36', 'not run')}**", "",
        f"Requested render mode for both TV channels: **{tv_vbo_mode}**.", "",
        "| Suite | Tests | Failures | Errors | Skipped |",
        "|---|---:|---:|---:|---:|",
    ]
    statuses = [("Build checks", build_status)] + ([] if local else [
        (f"API {version} device tests", device_statuses.get(version, "not run"))
        for version in ("34", "36")
    ])
    for label, status in statuses:
        if status != "success":
            problems.append(f"{label} did not succeed ({status})")
    for label, relative, minimum in (GROUPS[:1] if local else GROUPS):
        counts, errors = read_results(build_dir / relative)
        lines.append(f"| {label} | {counts['tests']} | {counts['failures']} | "
                     f"{counts['errors']} | {counts['skipped']} |")
        problems.extend(f"{label}: {error}" for error in errors)
        if counts["tests"] < minimum:
            problems.append(f"{label}: expected at least {minimum} tests, found {counts['tests']}")
        if any(counts[key] for key in ("failures", "errors", "skipped")):
            problems.append(f"{label}: failures, errors and skipped tests must all be zero")

    if local:
        lines.extend(["", "Device tests: **NOT RUN**. The instrumentation APK is compiled only; no emulator or physical device is contacted."])
    else:
        lines.extend(["", "| Platform | Requested mode | Active VBO | GL renderer | GL version | Display px | Window px | Surface px | Scale |",
                      "|---|---|---|---|---|---|---|---|---|"])
        for version, mode in (("34", tv_vbo_mode), ("36", tv_vbo_mode)):
            records, errors = read_render_evidence(build_dir / f"outputs/androidTest-results/api-{version}", mode, version)
            problems.extend(f"API {version}: {error}" for error in errors)
            for record in records:
                renderer = record["renderer"].replace("|", "\\|").replace("\n", " ")
                gl_version = record["version"].replace("|", "\\|").replace("\n", " ")
                dimensions = [f"{record[prefix + 'Width']}x{record[prefix + 'Height']}" for prefix in ("display", "window", "surface")]
                lines.append(f"| API {version} | {mode} | {str(record['activeVbo']).lower()} | {renderer} | {gl_version} | "
                             + " | ".join(dimensions) + f" | {record['scale']} |")
        lines.extend(diagnostic_summary(build_dir))
    lint = build_dir / "reports/lint-results-debug.xml"
    try:
        issues = ET.parse(lint).getroot().findall("issue")
        errors = sum(issue.get("severity") in ("Error", "Fatal") for issue in issues)
        warnings = sum(issue.get("severity") == "Warning" for issue in issues)
        lines.extend(["", f"Lint: **{errors} errors, {warnings} warnings**"])
        if errors: problems.append("Lint contains errors")
    except (OSError, ET.ParseError):
        problems.append("Lint XML report is missing or invalid")
    for label, relative in (("APK", "debug/BattleCity-debug.apk"),
                            ("Instrumentation APK", "androidTest/debug/BattleCity-debug-androidTest.apk")):
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
    parser.add_argument("--local", action="store_true", help="Check local build artifacts without requiring device results")
    args = parser.parse_args()
    build_dir = Path("build")
    summary, problems = evaluate(
        build_dir, os.environ.get("BUILD_STATUS", "not run"),
        {"34": os.environ.get("DEVICE_API34_STATUS", "not run"),
         "36": os.environ.get("DEVICE_API36_STATUS", "not run")},
        os.environ.get("GITHUB_SHA", "local workspace"), local=args.local,
        tv_vbo_mode=os.environ.get("BATTLECITY_TV_VBO_MODE", "default"),
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
