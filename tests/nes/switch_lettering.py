"""Compare the compiled brick lettering to cell masks measured on Switch recordings."""
import argparse
from hashlib import sha256
from pathlib import Path
import re

# Map offset in tiles, columns, horizontal and vertical offset of the first cell.
# The title is from My Gameplay Videos at 5:31, the ending from Crolister at 43:34.
WORDS = (
    ('BATTLE', 0, 24, 0, 0, '58013af87c8391a6a4b20d6a0c2160913152c94569b01f6de3044cf563bd07a3'),
    ('CITY', 96, 16, -4, 0, '468da452c1a64355003e3c3f9fdcac4f6f1f8371f6b5a99493e21c484d0aea5f'),
    ('GAME', 160, 16, -4, 0, '5bb477dac51394526882ea020334ce8f9835f606db21c4dc8fdb63cb03793b5a'),
    ('OVER', 224, 16, -4, 4, 'b70d9d20815a7d6ed5dd3da1a90516ca2815a573a2801a932b6d88b9d45a289c'),
)


def verify(image, labels):
    address = int(re.search(r'^al ([0-9a-fA-F]+) \._large_letters$', labels, re.M)[1], 16)
    tilemap = image[16 + address - 0x8000:]
    chr_data = image[16 + image[4] * 16384:]
    for name, start, stride, dx, dy, expected in WORDS:
        def colored(x, y):
            if not 0 <= x < stride * 8:
                return False
            tile = tilemap[start + y // 8 * stride + x // 8]
            row = tile * 16 + y % 8
            return (chr_data[row] | chr_data[row + 8]) & (128 >> (x % 8)) != 0

        mask = bytearray()
        for cy in range(7):
            for cx in range(len(name) * 8):
                count = sum(colored(4*cx + dx + u, 4*cy + dy + v) for u in range(4) for v in range(4))
                mask.append(count >= 9)
        assert sha256(mask).hexdigest() == expected, name + ' outline differs from the Switch frame'
    print('1008 title and ending lettering cells match the Switch recordings')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rom', type=Path)
    parser.add_argument('labels', type=Path)
    args = parser.parse_args()
    verify(args.rom.read_bytes(), args.labels.read_text())
