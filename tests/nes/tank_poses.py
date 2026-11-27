"""Check OAM positioning, palettes, priority and visible CHR pixels for every sampled pose."""
import argparse
import csv
import hashlib
import itertools
from pathlib import Path

from switch_shell_capture import ACCEPTED_ROM

FIXTURE = Path(__file__).with_name('fixtures') / 'switch-shells' / 'tank-poses.csv'
SCENES = ('open', 'forest', 'edge', 'crowded')
FIELDS = ('slot', 'grade', 'direction', 'tread', 'scene', 'sha256')
CASES = tuple(itertools.product(range(3), range(4), range(4), range(2), SCENES))


def sprites(rom, data):
    result = []
    for i in range(0, len(data), 4):
        y, tile, attr, x = data[i:i+4]
        start = 16 + 32768 + 4096 + tile * 16
        tile = rom[start:start+16]
        pixels = []
        for row in range(8):
            sy = 7-row if attr & 128 else row
            for col in range(8):
                bit = col if attr & 64 else 7-col
                pixels.append(((tile[sy] >> bit) & 1) | (((tile[sy+8] >> bit) & 1) << 1))
        result.append((x, y, attr & 63, pixels))
    return result


def capture(rom, log):
    records = {}
    for line in log.read_text().splitlines():
        if not line.startswith('BATTLECITY_POSE '):
            continue
        _, slot, grade, direction, tread, scene, data = line.split()
        key = (int(slot), int(grade), int(direction), int(tread), scene)
        entries = sprites(rom, bytes.fromhex(data))
        count = 2 if scene == 'crowded' else 8 if scene == 'forest' and int(slot) < 2 else 4
        if len(entries) != count or key in records:
            raise ValueError(f'invalid sprite count or duplicated pose: {key}')
        records[key] = entries
    if set(records) != set(CASES):
        raise ValueError(f'incomplete pose matrix: {set(CASES) ^ set(records)}')
    return records


def signature(entries):
    h = hashlib.sha256()
    for x, y, attr, pixels in entries:
        h.update(bytes((x, y, attr, *pixels)))
    return h.hexdigest()


def expected(entries, full, direction):
    # Apply the measured one-pixel correction to the full old body before OAM
    # clipping. Keep each quadrant's placement/priority and any shield unchanged.
    body = [[full[2*(y//8)+x//8][3][8*(y%8)+x%8] for x in range(16)] for y in range(16)]
    body = [row[1:]+[0] for row in body] if direction == 0 else body[::-1]
    result = []
    for i, (x, y, attr, pixels) in enumerate(entries):
        if i < 4:
            qx, qy = 8*(i%2), 8*(i//2)
            pixels = [value for row in body[qy:qy+8] for value in row[qx:qx+8]]
        result.append((x, y, attr, pixels))
    return result


def reference(rom, records, path):
    if hashlib.sha256(rom).hexdigest() != ACCEPTED_ROM:
        raise ValueError('golden poses require the accepted cartridge')
    with path.open('w', newline='') as f:
        writer = csv.writer(f, lineterminator='\n')
        writer.writerow(FIELDS)
        for key in CASES:
            slot, grade, direction, tread, _ = key
            entries = records[key]
            if slot < 2 and grade == 0 and direction in (0, 3):
                entries = expected(entries, records[slot, grade, direction, tread, 'open'], direction)
            writer.writerow((*key, signature(entries)))


def verify(rom, log):
    actual = capture(rom, log)
    with FIXTURE.open(newline='') as f:
        reader = csv.reader(f)
        if next(reader) != list(FIELDS):
            raise ValueError('unexpected pose fixture header')
        for key in CASES:
            row = next(reader)
            if row[:5] != list(map(str, key)) or signature(actual[key]) != row[5]:
                raise ValueError(f'pose pixels or OAM placement/attributes differ: {key}')
        if next(reader, None) is not None:
            raise ValueError('unexpected pose fixture row')
    return len(CASES)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rom', type=Path)
    parser.add_argument('barrels', type=Path)
    parser.add_argument('--write-reference', type=Path)
    args = parser.parse_args()
    rom = args.rom.read_bytes()
    if args.write_reference:
        reference(rom, capture(rom, args.barrels), args.write_reference)
    else:
        print(f'{verify(rom, args.barrels)} matched tank poses')
