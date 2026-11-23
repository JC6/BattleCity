"""Compare all stage cells and spawn types in a linked iNES cartridge."""
import argparse
from hashlib import sha1, sha256
from pathlib import Path


def unpack_rows(data, row_stride, high_first):
    cells = bytearray()
    for y in range(13):
        for x in range(13):
            index = y * row_stride + x
            shift = 4 if (index % 2 == 0) == high_first else 0
            cells.append(data[index // 2] >> shift & 15)
    return cells


def reference(rom):
    assert sha1(rom).hexdigest() == 'e1061c9241b06a965fb7845cb951d921aca010ef'
    prg = rom[16:16 + 16384]
    for stage in range(35):
        types = prg[0x24ec+stage*4:0x24f0+stage*4]
        counts = prg[0x2578+stage*4:0x257c+stage*4]
        queue = bytes((kind-128)//32 for kind, count in zip(types, counts) for _ in range(count))
        assert len(queue) == 20
        yield unpack_rows(prg[0x307a+stage*91:], 14, True), queue, counts


def cartridge(rom, symbols):
    addresses = {s[2]: int(s[1], 16)-0x8000+16 for s in
                 (line.split() for line in symbols.read_text().splitlines()) if len(s)==3}
    for stage in range(35):
        board = addresses['._maps'] + stage*85
        packed = addresses['._enemies'] + stage*5
        queue = bytes((rom[packed + i//4] >> (2*(i%4))) & 3 for i in range(20))
        counts = addresses['._enemy_groups'] + stage*4
        yield unpack_rows(rom[board:], 13, False), queue, rom[counts:counts+4]


def digest(rows):
    return ''.join(f'{stage},{sha256(cells).hexdigest()},{sha256(queue).hexdigest()},{counts.hex()}\n'
                   for stage, (cells, queue, counts) in enumerate(rows, 1))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rom', type=Path)
    parser.add_argument('--labels', type=Path)
    args = parser.parse_args()
    data = args.rom.read_bytes()
    if args.labels is None:
        print(digest(reference(data)), end='')
    else:
        want = (Path(__file__).parent/'fixtures/catalogue.csv').read_text().splitlines()
        got = digest(cartridge(data, args.labels)).splitlines()
        assert len(want) == len(got) == 35
        for i, (a, b) in enumerate(zip(want, got), 1):
            if a != b:
                raise ValueError(f'Stage {i}: expected {a}, got {b}')
        print('35 layouts, 140 wave counts and 700 ordered spawns match the reference')
