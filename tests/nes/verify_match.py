"""Run the independent stage, attract, ending and full-match fixtures in MAME."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rom", type=Path)
    parser.add_argument("--labels", type=Path)
    parser.add_argument("--mame", default=os.environ.get("MAME", "mame"))
    parser.add_argument("--traces", type=Path, help="save the measured CSVs")
    args = parser.parse_args()
    rom = args.rom.resolve()
    labels = (args.labels or rom.with_suffix(".lbl")).resolve()
    traces = args.traces.resolve() if args.traces else None
    if traces:
        traces.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, HERE / "catalogue.py", rom, "--labels", labels], check=True)

    cases = [("attract", "", key) for key in ("start", "select", "p2-start", "p2-select", "natural")]
    cases.extend(("ending", name, keys) for name in ("solo", "coop", "base", "lives")
                 for keys in ("neutral", "tap", "hold"))
    cases.append(("ending", "base", "record"))
    cases.extend(("campaign", name, "neutral") for name in ("solo", "coop"))
    with tempfile.TemporaryDirectory() as work:
        for suite, name, keys in cases:
            env = {k: v for k, v in os.environ.items() if not k.startswith("BATTLECITY_")}
            env.update(SDL_VIDEODRIVER="dummy", BATTLECITY_LABELS=str(labels),
                       BATTLECITY_SCENARIO=name, BATTLECITY_END_INPUT=keys, BATTLECITY_ATTRACT_INPUT=keys)
            if name and keys != "record":
                base = HERE / "fixtures" / suite / name
                env["BATTLECITY_GOLDENS"] = str(base.with_suffix(".csv"))
                if suite == "campaign":
                    env["BATTLECITY_INPUT"] = str(base.with_suffix(".pads"))
                if traces:
                    env["BATTLECITY_TRACE"] = str(traces / f"{suite}-{name}-{keys}.csv")
            elif traces and suite == "attract" and keys == "natural":
                env["BATTLECITY_TRACE"] = str(traces / "attract-natural.csv")
            result = subprocess.run([args.mame, "nes", "-cart", rom, "-video", "none",
                                     "-sound", "none", "-nothrottle", "-skip_gameinfo",
                                     "-seconds_to_run", "205" if keys == "natural" else "160", "-autoboot_delay", "0",
                                     "-autoboot_script", HERE / f"{suite}.lua"], cwd=work,
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True)
            key = " ".join(filter(None, (suite, name, keys)))
            if result.returncode or f"BATTLECITY_{suite.upper()}_OK" not in result.stdout.splitlines():
                raise SystemExit(f"{key} failed\n{result.stdout}")
            print(f"{key} passed", flush=True)


if __name__ == "__main__":
    main()
