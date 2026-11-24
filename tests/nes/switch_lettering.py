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
    ('HISCORE', 288, 28, 0, 4, '377bfffadd421d71bb9b9da50cd83a7c43944a6801eb0f4f296e3af522235ccd'),
    ('1', 404, 40, 0, 0, '145a3d11a69543b53e876d22e86b852ca71974c2c78667a75f80c9acb66b5cec'),
    ('8', 432, 40, 0, 0, '410eb0d6d1dbb8fdebad862899108720b139ab625988471474a258b5098f04e6'),
    ('5', 420, 40, 0, 0, '0f99699eee098b015c8480cfdd1d8443b9cc75f0f8ba10f29e63575287e94117'),
    ('9', 436, 40, 0, 0, 'a633815578ad63b098bd0e70aeee7a7a87bfb4b71b30bb092a511d1c5f1e2596'),
    ('0', 400, 40, 0, 0, '824b268620853b4c9d15b320b63c120a01a7f0643737659fc06d92f12941e287'),
)


def cartridge_tables(image, labels):
    address = int(re.search(r'^al ([0-9a-fA-F]+) \._large_letters$', labels, re.M)[1], 16)
    return image[16 + address - 0x8000:], image[16 + image[4] * 16384:]


def compiled_cells(tilemap, chr_data, start, stride, dx, dy, columns):
    def colored(x, y):
        if not 0 <= x < stride * 8:
            return False
        tile = tilemap[start + y // 8 * stride + x // 8]
        row = tile * 16 + y % 8
        return (chr_data[row] | chr_data[row + 8]) & (128 >> (x % 8)) != 0

    mask = bytearray()
    for cy in range(7):
        for cx in range(columns):
            count = sum(colored(4*cx + dx + u, 4*cy + dy + v) for u in range(4) for v in range(4))
            mask.append(count >= 9)
    return mask


def verify(image, labels, secondary=False):
    tilemap, chr_data = cartridge_tables(image, labels)
    for name, start, stride, dx, dy, expected in WORDS:
        mask = compiled_cells(tilemap, chr_data, start, stride, dx, dy, len(name)*8)
        assert sha256(mask).hexdigest() == expected, name + ' outline differs from the Switch frame'
    print('1008 title/ending and 672 high-score lettering cells match the Switch recordings')


    if secondary:
        # 26800 in the Japanese commentary and 441900 in the Famicom capture.
        # The capture-specific measurement also checks the shared English masks.
        digits = {
            '2': '21965a4a44a61e34772adf19563c1e57abb393e9f1d490ccc67bcd49ec3a4eb5',
            '4': '389e132ba94aff0529d8ebeedf9613b902b03ecf2caea7e639e5d9c2e7f7e231',
            '6': 'bed1982a27117578e70d99a3191a60cea150e4abb60354ad87c38505364a737d',
        }
        for key,expected in digits.items():
            mask=compiled_cells(tilemap,chr_data,400+4*int(key),40,0,0,8)
            assert sha256(mask).hexdigest()==expected, 'supplementary high-score digit '+key
        print('168 additional high-score cells match the separately identified commentary and Famicom sources')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rom', type=Path)
    parser.add_argument('labels', type=Path)
    parser.add_argument("--secondary",action="store_true",help="also verify the separately measured 2, 4 and 6")
    args = parser.parse_args()
    verify(args.rom.read_bytes(), args.labels.read_text(), args.secondary)
