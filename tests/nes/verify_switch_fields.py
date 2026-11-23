"""Compare permanent terrain with GetNavi's published Switch captures of stages 33 and 35."""
import argparse
import csv
import hashlib
from pathlib import Path
import subprocess

FIELDS = Path(__file__).resolve().parent / 'fixtures/stages'
# Image SHA-256, image height, top of playfield, bottom (exclusive).
CAPTURES = {
    33: ('4932497faef9f8a5b33c46537da08ad5df4d7bc5bfd67872e4b501bfef4b0f2f', 885, 32, 854),
    35: ('32818be1e41cf9008faf3082ec4b49f63fc1fdc806572aaec6fadf3874bb8cf3', 887, 34, 856),
}
# A star covers the lower-left corner of the bottom-right forest on stage 35.
OCCLUDED = {(35, 22, 21)}
MATERIALS = {3: 'water', 4: 'forest'}


def compare(stage, path):
    digest, height, top, bottom = CAPTURES[stage]
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f'Stage {stage} capture has a different digest')
    pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-threads', '1', '-i', path,
                                     '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    if len(pixels) != 1200 * height * 3:
        raise ValueError(f'Unexpected dimensions for stage {stage}')
    rows = [bytes.fromhex(row) for row in (FIELDS / f'{stage}.field').read_text().split('/')[:26]]
    expected = {kind: 0 for kind in MATERIALS}
    visible = expected.copy()
    for y, row in enumerate(rows):
        for x, tile in enumerate(row):
            # Sample the middle 70 percent of each 8x8 NES tile to avoid JPEG
            # ringing at its borders. The playfield spans x=73 through x=1052.
            count = 0
            colours = {kind: 0 for kind in MATERIALS}
            for v in range(int(top+(y+.15)*(bottom-top)/26), int(top+(y+.85)*(bottom-top)/26), 2):
                for u in range(int(73+(x+.15)*980/26), int(73+(x+.85)*980/26), 2):
                    offset = 3*(v*1200+u)
                    r,g,b = pixels[offset:offset+3]
                    colours[3] += b > 74 and b > r+32 and b > g+18
                    colours[4] += g > 65 and g > r+20 and g > b+25
                    count += 1
            for kind, material in MATERIALS.items():
                present = colours[kind] > count*.36
                expected[kind] += tile == kind
                visible[kind] += present
                if present == (tile == kind):
                    continue
                if kind == 4 and not present and (stage,x,y) in OCCLUDED:
                    continue
                raise ValueError(f'Stage {stage}, tile ({x},{y}), {material}: field={tile==kind}, capture={present}')
    return [[stage,material,expected[kind],visible[kind],expected[kind]-visible[kind]]
            for kind,material in MATERIALS.items()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage33', type=Path)
    parser.add_argument('stage35', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    rows = compare(33,args.stage33) + compare(35,args.stage35)
    if args.report:
        with args.report.open('w',newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['stage','material','map_tiles','visible_in_capture','obscured_by_powerup'])
            writer.writerows(rows)
    for stage,material,total,visible,obscured in rows:
        print(f'Stage {stage}, {material}: {visible}/{total} visible, {obscured} obscured')


if __name__ == '__main__':
    main()
