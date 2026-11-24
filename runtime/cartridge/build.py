"""Assemble the game using cc65 and the repository's 35-stage catalogue."""
import argparse
import ast
from pathlib import Path
import re
import subprocess
import tempfile

from audio_data import compile_audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# Original 5-by-7 lettering and pixel art for this cartridge.
LETTERS = {
    "A":"0e11111f111111", "B":"1e11111e11111e", "C":"0f10101010100f",
    "D":"1e11111111111e", "E":"1f10101e10101f", "F":"1f10101e101010",
    "G":"0f10101311110f", "H":"1111111f111111", "I":"0e04040404040e",
    "J":"0702020212120c", "K":"11121418141211", "L":"1010101010101f",
    "M":"111b1515111111", "N":"11191915131311", "O":"0e11111111110e",
    "P":"1e11111e101010", "Q":"0e11111115120d", "R":"1e11111e141211",
    "S":"0f10100e01011e", "T":"1f040404040404", "U":"1111111111110e",
    "V":"11111111110a04", "W":"1111111515150a", "X":"11110a040a1111",
    "Y":"11110a04040404", "Z":"1f01020408101f",
    "0":"0e11131519110e", "1":"040c040404040e", "2":"0e11010204081f",
    "3":"1e01010e01011e", "4":"02060a121f0202", "5":"1f10101e01011e",
    "6":"0e10101e11110e", "7":"1f010204080808", "8":"0e11110e11110e",
    "9":"0e11110f01010e", ">":"00080402040800", "-":"0000001f000000",
}


def art(logo_map):
    bank = bytearray(8192)
    assets=(ROOT/'web/src/game/pixel-assets.ts').read_text()

    def bitmap(name):
        return ast.literal_eval(re.search(r'export const '+name+r':[^=]*= ([\s\S]*?);',assets)[1])

    def colors(rows, mapping):
        return [row.translate(str.maketrans(mapping)) for row in rows]

    def tile(index, rows):
        assert len(rows) == 8 and all(len(row) == 8 for row in rows)
        for plane in range(2):
            for y, row in enumerate(rows):
                bank[index * 16 + plane * 8 + y] = sum(
                    ((int(pixel) >> plane) & 1) << (7 - x) for x, pixel in enumerate(row))

    for char, glyph in LETTERS.items():
        rows = [''.join('3' if value & (1 << bit) else '0' for bit in range(6, -1, -1)) + '0'
                for value in bytes.fromhex(glyph)]
        tile(ord(char), rows + ['00000000'])
    font_source=assets.split('export const FONT:',1)[1].split('};',1)[0]
    font={}
    for ch, rows in re.findall(r""""(.)": glyph\('([01 ]+)'\)""",font_source):
        font[ch]=rows.split()
        if ord(ch)<96 or ch=="©":
            tile(169 if ch=="©" else ord(ch), colors(rows.split(),{'1':'3'}))
    tile(ord('<'),colors(bitmap('ARROW'),{'1':'3','.':'0'}))
    tile(ord('>'),colors(bitmap('ARROW_RIGHT'),{'1':'3','.':'0'}))
    tile(20,['00000000']*3+['33333333']*2+['00000000']*3)
    brick = ['22223222', '11113211', '11113211', '33333333', '32222222', '32111111', '32111111', '33333333']
    tile(1, brick)
    for mask in range(1,16):
        tile(224+mask, [''.join(brick[y][x] if mask & (1 << (2*(y//4)+x//4)) else '0'
                                  for x in range(8)) for y in range(8)])
    tile(2, ['22222222', '22222221', '22333311', '22333311', '22333311', '22333311', '22111111', '21111111'])
    tile(3, ['11111111','11221112','22112221','11111111'] * 2)
    tile(4, ['00200020','02220222','22322232','00200020','02000200','22202220','23222322','02000200'])
    tile(5, ['22222223','22222232','22222322','22223222','22232222','22322222','23222222','32222222'])
    tile(6, ['00000000','30000003','23022032','22333322','02233220','00233200','02300320','00000000'])
    tile(7, ['11111111'] * 8)  # Gray surround.
    tile(12, ['33333333','00330330','03000300','00020000','00020000','03000300','00330330','33000333'])
    tile(14, ['33333333'] * 8)
    tile(22, ['33311133','31331331','31311131','31113111','31133311','31113111','31311131','31331331'])
    for q in range(4):
        rows = []
        for j in range(8):
            y = (q//2)*8+j
            rows.append(''.join('0' if x < 2 and y < 15 else
                                '1' if 1 <= y <= 8 and x < 2+2*y else '3'
                                for x in range((q%2)*8,(q%2+1)*8)))
        tile(24+q,rows)
    for first, chars in [(200,'0123456789P'),(212,'STAGE'),(240,'0123456789')]:
        for offset, char in enumerate(chars):
            rows = [''.join('0' if value & (1 << bit) else '3' for bit in range(6,-1,-1))+'3'
                    for value in bytes.fromhex(LETTERS[char])]
            tile(first+offset,rows+['33333333'])
    # All large lettering uses the same deduplicated 8px tiles.
    logo_tiles = {}
    for line in ('BATTLE','CITY','GAME','OVER','HISCORE','0123456789'):
        for tile_y in range(4):
            for tile_x in range(4*len(line)):
                char=line[tile_x//4]
                dx = 4 if line in ('CITY','GAME','OVER') else 0
                dy = 4 if line in ('OVER','HISCORE') else 0
                fill = '1' if line in ('HISCORE','0123456789') else '2'
                rows = []
                for j in range(8):
                    y = tile_y*8+j-dy
                    row = ''
                    for i in range(8):
                        x = (tile_x%4)*8+i+dx
                        col = x//4
                        ink = y>=0 and col<8 and font[char][y//4][col]=='1'
                        mortar = (x+4*(y//4))%8==4 or y%4==3
                        row += ('3' if mortar else fill) if ink else '0'
                    rows.append(row)
                key = tuple(rows)
                if key not in logo_tiles:
                    index=96+len(logo_tiles)
                    assert index<160
                    logo_tiles[key]=index
                    tile(index,rows)
                logo_map.append(logo_tiles[key])
    logo = colors(bitmap('NAMCOT'), {'.':'0', '1':'2'})
    for part in range(9):
        tile(160+part, [row[8*part:8*part+8] for row in logo])
    eagle = [
        '0000000000000000', '3300000000000033', '0330003330000330', '3333000323003333',
        '0333000330003330', '3333330330333333', '0032333333332300', '0333233333323330',
        '0033332332333300', '0033333333333300', '0003330330333000', '0000000330000000',
        '0000003333000000', '0000333333330000', '0000330330330000', '0000000000000000',
    ]
    for q in range(4):
        x,y=8*(q%2),8*(q//2)
        tile(8+q,[row[x:x+8] for row in eagle[y:y+8]])
    debris=colors(bitmap('DESTROYED_BASE'),{'.':'0','S':'1','W':'3'})
    for q in range(4):
        x,y=8*(q%2),8*(q//2)
        tile(16+q,[row[x:x+8] for row in debris[y:y+8]])
    # Two orientations plus hardware X/Y flips cover the four directions.
    # One extra frame per orientation exchanges the alternating track links.
    player = [
        '0000000000000000', '0000000000000000', '0000000030000000', '0000000030000000',
        '0032200030001220', '0011300030001110', '0032301131101220', '0011333222211110',
        '0032332211211220', '0011332321211110', '0032332321211220', '0011332332211110',
        '0032323222111220', '0011303322201110', '0032200000003220', '0000000000000000',
    ]
    enemy = [
        '0000000030000000', '0000000030000000', '0000000030000000', '0011200131001120',
        '0022201131202230', '0011211132232110', '0022211222332230', '0011212232232110',
        '0022212331232230', '0011212311232110', '0022212222232230', '0011212222332110',
        '0022202233302230', '0011200333002110', '0000000030000000', '0000000000000000',
    ]
    def square(index, rows):
        for q in range(4):
            x,y = 8*(q&1),8*(q>>1)
            tile(index+q,[row[x:x+8] for row in rows[y:y+8]])
    for kind in range(8):
        for tread in range(2):
            rows = [list(row) for row in (player if kind < 4 else enemy)]
            if kind & 3:
                for y in range(5,11):
                    rows[y][5] = '2'
                    if kind & 2: rows[y][10] = '2'
                if kind & 3 == 3: rows[10][6:10] = '3223'
            if tread:
                for y in range(2,14,2):
                    for x in (1,2,3,11,12,13):
                        if rows[y][x]!='0' and rows[y+1][x]!='0':
                            rows[y][x],rows[y+1][x]=rows[y+1][x],rows[y][x]
            square(256+kind*16+tread*8,rows)
            square(260+kind*16+tread*8,list(zip(*rows[::-1])))
    # White spawn flash measured at both stage-one spawn points on Switch.
    # Each list gives the horizontal radius by distance from the middle row.
    star_radii = ((4,1,0,0,0), (5,2,1,0,0,0),
                  (6,3,1,1,0,0,0), (7,4,2,1,1,0,0,0))
    for phase, radii in enumerate(star_radii):
        rows = []
        for y in range(16):
            dy = abs(y-8)
            radius = radii[dy] if dy < len(radii) else -1
            rows.append(''.join('3' if abs(x-7) <= radius else '0' for x in range(16)))
        square(416+phase*4, rows)
    # The two white shield outlines alternate around the player sprite.
    shield_quarters = (
        ('......##','.....#..','....#...','....#...','..##....','.#......','#.......','#.......'),
        ('..##....','.#..#...','#....##.','#......#','.#......','..#.....','..#.....','...#....'),
    )
    for phase, quarter in enumerate(shield_quarters):
        top = [row+row[::-1] for row in quarter]
        square(432+phase*4, colors(top+top[::-1], {'.':'0','#':'3'}))
    tile(440, ['02200000','23320000','23320000','02200000'] + ['00000000']*4)
    for phase, radius in enumerate((7,5,3)):
        tile(442+phase, [''.join('3' if abs(2*x-7)+abs(2*y-7)<radius else
                                 '2' if abs(2*x-7)==abs(2*y-7)<=radius else '0'
                                 for x in range(8)) for y in range(8)])
    tile(441, ['33333333','30000003','30000003','30000003','30000003','30000003','30000003','33333333'])
    # Render the six pickup symbols inside a 16px case, plus two blast frames.
    icons = [
        ['0001000','0001000','1111111','0111110','0011100','0110110','0100010'],
        ['0011100','0111110','0111110','0111110','1111111','1100011','1000001'],
        ['0011100','0101010','1001001','1001101','1000001','0100010','0011100'],
        ['0001000','1001001','1111111','1011101','1011101','1000001','1100011'],
        ['0001110','0010011','0011100','0111110','1111111','1111111','0111110'],
        ['0000111','0000101','0000110','0001000','0110000','1111000','0110000'],
    ]
    for kind, symbol in enumerate(icons):
        block = [['3' if x in (0,15) or y in (0,15) else '0' for x in range(16)] for y in range(16)]
        for y in range(13):
            for x in range(13):
                if symbol[y//2][x//2]=='1': block[1+y][1+x]='3'
        for q in range(4):
            x,y=8*(q%2),8*(q//2)
            tile(384+kind*4+q,[''.join(row[x:x+8]) for row in block[y:y+8]])
    explosions=[colors(rows,{'.':'0','D':'1','R':'2','W':'3'}) for rows in bitmap('EXPLOSION_FRAMES')]
    for index,rows in zip((152,156),explosions[:2]):
        square(256+index,rows)
    for i, ch in enumerate('PAUSEGAMEOVER'):
        bits=bytes.fromhex(LETTERS[ch])
        rows=[''.join('2' if value & (1<<x) else '0' for x in range(6,-1,-1))+'0' for value in bits]
        tile(445+i,rows+['00000000'])
    for i in range(5):
        tile(445+i,colors([row.ljust(40,'.')[i*8:i*8+8] for row in (bitmap('PAUSE')+['.'*40]*8)[:8]],{'.':'0','R':'2'}))
    for phase,rows in enumerate(explosions[3:]):
        for q in range(4):
            x,y=16*(q&1),16*(q>>1)
            square(458+phase*16+q*4,[row[x:x+16] for row in rows[y:y+16]])
    for k in range(5):
        rows=bitmap('POINT_BITMAPS')[str((k+1)*100)]
        square(490+4*k,colors(rows,{'.':'0','W':'3'}))
    return bank


def catalogue():
    text = (ROOT/'web/src/data/original.ts').read_text()
    arrays = re.findall(r'=\s*(\[.*?\]);', re.sub(r'//[^\n]*', '', text), re.S)
    maps, queues = map(ast.literal_eval, arrays)
    assert len(maps) == len(queues) == 35
    out = bytearray()
    for board in maps:
        assert len(board) == 13 and all(len(row) == 13 for row in board)
        assert all(0 <= value <= 13 for row in board for value in row)
        cells = [value for row in board for value in row] + [0]
        out.extend(a | (b << 4) for a, b in zip(cells[::2], cells[1::2]))
    for queue in queues:
        assert len(queue) == 20 and all(0 <= value <= 3 for value in queue)
        for i in range(0, len(queue), 4):
            out.append(sum(kind << (2 * lane) for lane, kind in enumerate(queue[i:i + 4])))
    # Each stage advances through four slots, including empty waves. Their
    # remaining counts also participate in the cartridge's random sequence.
    groups = [
        (18,2,0,0), (2,4,0,14), (14,4,0,2), (10,5,2,3), (5,2,8,5),
        (7,2,9,2), (3,4,6,7), (7,2,4,7), (6,4,7,3), (12,2,4,2),
        (5,6,4,5), (8,6,0,6), (8,8,0,4), (10,4,0,6), (2,0,10,8),
        (16,0,2,2), (2,2,8,8), (4,2,6,8), (4,8,4,4), (8,2,2,8),
        (8,2,6,4), (8,6,2,4), (6,0,4,10), (4,2,4,10), (2,8,0,10),
        (6,6,4,4), (2,8,8,2), (2,1,15,2), (10,4,0,6), (4,8,4,4),
        (3,8,6,3), (8,6,2,4), (4,8,4,4), (4,10,0,6), (4,6,0,10),
    ]
    for queue, counts in zip(queues, groups, strict=True):
        offset = 0
        for count in counts:
            assert len(set(queue[offset:offset + count])) <= 1
            offset += count
        assert offset == len(queue)
        out.extend(counts)
    return out


def build(output, labels=None):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        work = Path(temp)
        logo_map=bytearray()
        (work/'art.chr').write_bytes(art(logo_map))
        (work/'logo.bin').write_bytes(logo_map)
        (work/'levels.bin').write_bytes(catalogue())
        (work/'audio.inc').write_text(compile_audio(ROOT/'web/src/platform/audio-cues.ts'))
        def run(args):
            subprocess.run(args, cwd=work, check=True)
        run(['cc65','-g','-t','nes','-Oirs','-o','game.s',str(HERE/'game.c')])
        run(['ca65','-g','-t','nes','-o','game.o','game.s'])
        run(['ca65','-t','nes','--bin-include-dir',temp,'-o','boot.o',str(HERE/'boot.s')])
        run(['ca65','-t','nes','-I',temp,'-o','audio.o',str(HERE/'audio.s')])
        run(['cl65','-t','nes','-C',str(HERE/'nrom.cfg'),'-Ln','game.lbl','-o','game.nes','boot.o','game.o','audio.o'])
        rom=(work/'game.nes').read_bytes()
        assert len(rom)==16+32768+8192
        output.write_bytes(rom)
        if labels:
            labels.write_bytes((work/'game.lbl').read_bytes())


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--labels',type=Path)
    args=parser.parse_args()
    build(args.output,args.labels)
