#!/usr/bin/env python3
"""Require real JUnit results for the repository-derived Android build. Standard library only."""

import argparse
import hashlib
import re
import shutil
import subprocess
import os
from pathlib import Path
import xml.etree.ElementTree as ET


GROUPS = (
    ("JVM", "test-results/testDebugUnitTest", 163),
    ("API 34 device", "outputs/androidTest-results/api-34", 41),
    ("API 37.2 device", "outputs/androidTest-results/api-37.2", 41),
)


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


def evaluate(build_dir, build_status, device_statuses, commit, local=False):
    problems = []
    lines = [
        "# Android framework validation", "", f"Commit: `{commit}`", "",
        "Data: **shared source-generated game data**; no external pack is required.",
        "These checks validate the adaptation and Android framework, not a complete pixel-exact original-game match.", "",
        f"Build / unit tests / lint: **{build_status}**",
        f"API 34 emulator test command: **{device_statuses.get('34', 'not run')}**",
        f"API 37.2 emulator test command: **{device_statuses.get('37.2', 'not run')}**", "",
        "| Suite | Tests | Failures | Errors | Skipped |",
        "|---|---:|---:|---:|---:|",
    ]
    statuses = [("Build checks", build_status)] + ([] if local else [
        (f"API {version} device tests", device_statuses.get(version, "not run"))
        for version in ("34", "37.2")
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
    lines.extend(["", "**NOT ACCEPTED**" if problems else ("**LOCAL CHECKS PASSED — device validation pending**" if local else "**PASSED**"), ""])
    lines.extend(f"- {problem}" for problem in problems)
    lines.extend(["", "No APK is published by this workflow. Tests use the same game resources as local builds and simulated controllers. Actual device firmware, "
                  "Bluetooth mappings, display and audio latency still require device checks.", ""])
    return "\n".join(lines), problems


def verify_apks(build_dir):
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    candidates = list((Path(sdk) / "build-tools").glob("*/apksigner")) if sdk else []
    signer = max(candidates, key=lambda path: tuple(int(n) for n in re.findall(r"\d+", path.parent.name))) if candidates else shutil.which("apksigner")
    if not signer: return "APK signatures: **NOT VERIFIED**", ["apksigner was not found"]
    certificates = []
    for relative in ("debug/BattleCity-debug.apk", "androidTest/debug/BattleCity-debug-androidTest.apk"):
        try:
            run = subprocess.run([str(signer), "verify", "--print-certs", str(build_dir / "outputs/apk" / relative)],
                                 capture_output=True, text=True)
        except OSError:
            return "APK signatures: **NOT VERIFIED**", ["apksigner could not be started"]
        match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-f]+)", run.stdout)
        if run.returncode or not match:
            return "APK signatures: **FAILED**", [f"Signature verification failed: {relative}"]
        certificates.append(match[1])
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
         "37.2": os.environ.get("DEVICE_API37_STATUS", "not run")},
        os.environ.get("GITHUB_SHA", "local workspace"), local=args.local,
    )
    signatures, failures = verify_apks(build_dir)
    if failures and not problems:
        summary = summary.replace("**PASSED**", "**NOT ACCEPTED**").replace(
            "**LOCAL CHECKS PASSED — device validation pending**", "**NOT ACCEPTED**")
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
