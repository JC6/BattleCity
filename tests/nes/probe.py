"""Build an original two-controller NROM cartridge, optionally replay it in MAME."""
from array import array
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import wave


def cartridge():
    program = bytearray()

    def emit(instructions):
        program.extend(bytes.fromhex(instructions))

    # Disable rendering and NMI, initialize stack, wait for two vertical blanks.
    emit("78 d8 a2 ff 9a a9 00 85 00 8d 00 20 8d 01 20")
    emit("2c 02 20 10 fb 2c 02 20 10 fb")
    # Enable pulse channel 1 with constant volume and a repeating length counter.
    emit("a9 01 8d 15 40 a9 bf 8d 00 40 a9 00 8d 01 40")
    emit("a9 ab 8d 02 40 a9 01 8d 03 40 a9 80 8d 00 20")
    idle = 0x8000 + len(program)
    program.extend(b'\x4c' + idle.to_bytes(2, 'little'))
    nmi = 0x8000 + len(program)
    # Latch both controllers. A on each port selects a different palette and pitch.
    emit("a9 01 8d 16 40 a9 00 8d 16 40")
    emit("ad 16 40 29 01 85 01 ad 17 40 29 01 85 02")
    emit("0a 05 01 0a 0a 0a 85 03 09 80 8d 02 40")
    emit("e6 00 2c 02 20 a9 3f 8d 06 20 a9 00 8d 06 20")
    emit("a5 00 18 65 03 29 3f 8d 07 20 a9 00 8d 06 20 8d 06 20 40")
    program.extend(bytes(16384 - 6 - len(program)))
    for vector in (nmi, 0x8000, idle):
        program.extend(vector.to_bytes(2, "little"))
    return b"NES\x1a\x01\x01" + bytes(10) + program + bytes(8192)


def check_sound(path):
    # Each held A-button combination selects a different pulse timer.
    with wave.open(str(path)) as recording:
        if recording.getsampwidth() != 2:
            raise ValueError("Expected 16-bit PCM")
        rate = recording.getframerate()
        pcm = array("h", recording.readframes(recording.getnframes()))
        if sys.byteorder != "little":
            pcm.byteswap()
        channel = pcm[::recording.getnchannels()]
    pitches = [1789773 / (16 * (0x181 + 8 * mask)) for mask in range(4)]
    heard = set()
    last_tone = None
    window = rate // 10
    for start in range(0, len(channel) - window, window // 2):
        samples = channel[start:start + window]
        edges = [n for n in range(1, window) if samples[n - 1] <= 0 < samples[n]]
        if len(edges) < 3:
            continue
        frequency = rate * (len(edges) - 1) / (edges[-1] - edges[0])
        for mask, pitch in enumerate(pitches):
            if abs(pitch - frequency) < 1:
                heard.add(mask)
                last_tone = mask
    if last_tone != 2:
        raise ValueError("Audio did not follow the new player-two input branch")
    if len(heard) != 4:
        raise ValueError(f"Missing controller tones for masks {set(range(4)) - heard}")


def run(binary, rom):
    script = Path(__file__).with_name("replay.lua").resolve()
    with tempfile.TemporaryDirectory() as folder:
        audio = Path(folder, "audio.wav")
        command = [binary, "nes", "-cart", str(rom), "-video", "none", "-sound", "none",
             "-wavwrite", str(audio), "-nothrottle", "-seconds_to_run", "12",
             "-skip_gameinfo", "-autoboot_delay", "0", "-autoboot_script", str(script)]
        for cold in ("0", "1"):
            result = subprocess.run(command, cwd=folder, capture_output=True, text=True,
                                    env={**os.environ, "BATTLECITY_COLD_REPLAY": cold}, timeout=90)
            if result.returncode or "MAME_REPLAY_OK" not in result.stdout.splitlines():
                raise SystemExit(result.stdout + result.stderr)
            check_sound(audio)
        print("MAME: 120 full frames matched after warm and cold restore; both pads and four tones verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mame", help="MAME executable on PATH or absolute path")
    options = parser.parse_args()
    options.output.write_bytes(cartridge())
    if options.mame:
        run(options.mame, options.output.resolve())
