"""Measure a recorded stage-opening cue against the Switch recording with FFmpeg."""
import argparse
from array import array
import cmath
import math
import statistics
import subprocess
import sys


def fft(samples):
    if len(samples) == 1:
        return samples
    even = fft(samples[::2])
    odd = fft(samples[1::2])
    rotated = [value * cmath.exp(-1j * math.pi * i / len(odd)) for i, value in enumerate(odd)]
    return [a + b for a, b in zip(even, rotated)] + [a - b for a, b in zip(even, rotated)]


def spectra(path, start):
    rate = 8000
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', path,
                                   '-t', '12', '-vn', '-ac', '1', '-ar', str(rate), '-f', 's16le', '-'])
    pcm = array('h', raw)
    if sys.byteorder != 'little':
        pcm.byteswap()
    # Skip encoder noise and select the first millisecond with an audible signal.
    onset = next((i for i in range(0, len(pcm)-8, 8) if max(map(abs, pcm[i:i+8])) > 190), None)
    if onset is None or len(pcm) < onset + 124 * 80 + 256:
        raise ValueError('No complete opening cue in ' + path)
    window = [.5 - .5 * math.cos(2 * math.pi * i / 255) for i in range(256)]
    frames = []
    for hop in range(5, 125):
        offset = onset + hop * 80
        values = [value * weight for value, weight in zip(pcm[offset:offset+256], window)]
        band = [abs(component) for component in fft(values)[3:101]]
        norm = math.sqrt(sum(value * value for value in band))
        frames.append([value / norm if norm else 0.0 for value in band])
    return start + onset / rate, frames


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('switch_recording')
    parser.add_argument('game_recording')
    parser.add_argument('--switch-start', type=float, required=True, help='silent point preceding the cue, seconds')
    parser.add_argument('--game-start', type=float, required=True, help='silent point preceding the cue, seconds')
    args = parser.parse_args()
    switch_onset, switch = spectra(args.switch_recording, args.switch_start)
    game_onset, game = spectra(args.game_recording, args.game_start)
    similarities = [sum(x * y for x, y in zip(a, b)) for a, b in zip(switch, game)]
    print('switch_onset_s,game_onset_s,windows,mean_cosine,median_cosine')
    print(f'{switch_onset:.3f},{game_onset:.3f},{len(similarities)},'
          f'{statistics.mean(similarities):.3f},{statistics.median(similarities):.3f}')
