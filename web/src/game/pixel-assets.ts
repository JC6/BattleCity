import type { Direction, EnemyKind, PowerUpKind, Tank } from '../core/types';

/** Native pixel bitmaps shared by both renderers. */
export type Bitmap = readonly string[];
export interface PixelSurface {
  fillStyle(color: number, alpha?: number): unknown;
  fillRect(x: number, y: number, width: number, height: number): unknown;
}
export const PALETTE = {
  black: 0x000000, gray: 0x666666, light: 0xadadad, white: 0xfcfcfc,
  red: 0xbc3410, brick: 0xa05000, brickDark: 0x801000,
  yellow: 0xf8b800, olive: 0x687000, playerGreen: 0x008800, playerGreenDark: 0x006800, enemyDark: 0x004058,
  green: 0x80d010, greenDark: 0x005800,
};
export const BURST_COLORS = { W: PALETTE.white, R: PALETTE.red, D: 0x440064 };
export function drawBitmap(g: PixelSurface, rows: Bitmap, x: number, y: number, colors: Readonly<Record<string, number>>, scale = 1): void {
  rows.forEach((row, py) => {
    for (let px = 0; px < row.length;) {
      const color = colors[row[px]];
      if (color === undefined) { px++; continue; }
      let end = px + 1;
      while (end < row.length && colors[row[end]] === color) end++;
      g.fillStyle(color); g.fillRect(x + px * scale, y + py * scale, (end - px) * scale, scale);
      px = end;
    }
  });
}
const glyph = (rows: string): Bitmap => rows.split(' ');
export const FONT: Readonly<Record<string, Bitmap>> = {
  "0": glyph('00011100 00100110 01100011 01100011 01100011 00110010 00011100 00000000'),
  "1": glyph('00001100 00011100 00001100 00001100 00001100 00001100 00111111 00000000'),
  "2": glyph('00111110 01100011 00000111 00011110 00111100 01110000 01111111 00000000'),
  "3": glyph('00111111 00000110 00001100 00011110 00000011 01100011 00111110 00000000'),
  "4": glyph('00001110 00011110 00110110 01100110 01111111 00000110 00000110 00000000'),
  "5": glyph('01111110 01100000 01111110 00000011 00000011 01100011 00111110 00000000'),
  "6": glyph('00011100 00110000 01100000 01111110 01100011 01100011 00111110 00000000'),
  "7": glyph('01111111 01100011 00000110 00001100 00011000 00011000 00011000 00000000'),
  "8": glyph('00111100 01100010 01110010 00111100 01001111 01000011 00111110 00000000'),
  "9": glyph('00111110 01100011 01100011 00111111 00000011 00000110 00111100 00000000'),
  "A": glyph('00011100 00110110 01100011 01100011 01111111 01100011 01100011 00000000'),
  "B": glyph('01111110 01100011 01100011 01111110 01100011 01100011 01111110 00000000'),
  "C": glyph('00011110 00110011 01100000 01100000 01100000 00110011 00011110 00000000'),
  "D": glyph('01111100 01100110 01100011 01100011 01100011 01100110 01111100 00000000'),
  "E": glyph('00111111 00110000 00110000 00111110 00110000 00110000 00111111 00000000'),
  "F": glyph('01111111 01100000 01100000 01111110 01100000 01100000 01100000 00000000'),
  "G": glyph('00011111 00110000 01100000 01100111 01100011 00110011 00011111 00000000'),
  "H": glyph('01100011 01100011 01100011 01111111 01100011 01100011 01100011 00000000'),
  "I": glyph('00111111 00001100 00001100 00001100 00001100 00001100 00111111 00000000'),
  "J": glyph('00000011 00000011 00000011 00000011 00000011 01100011 00111110 00000000'),
  "K": glyph('01100011 01100110 01101100 01111000 01111100 01101110 01100111 00000000'),
  "L": glyph('00110000 00110000 00110000 00110000 00110000 00110000 00111111 00000000'),
  "M": glyph('01100011 01110111 01111111 01111111 01101011 01100011 01100011 00000000'),
  "N": glyph('01100011 01110011 01111011 01111111 01101111 01100111 01100011 00000000'),
  "O": glyph('00111110 01100011 01100011 01100011 01100011 01100011 00111110 00000000'),
  "P": glyph('01111110 01100011 01100011 01100011 01111110 01100000 01100000 00000000'),
  "Q": glyph('00111110 01100011 01100011 01100011 01101111 01100110 00111101 00000000'),
  "R": glyph('01111110 01100011 01100011 01100111 01111100 01101110 01100111 00000000'),
  "S": glyph('00111100 01100110 01100000 00111110 00000011 01100011 00111110 00000000'),
  "T": glyph('00111111 00001100 00001100 00001100 00001100 00001100 00001100 00000000'),
  "U": glyph('01100011 01100011 01100011 01100011 01100011 01100011 00111110 00000000'),
  "V": glyph('01100011 01100011 01100011 01110111 00111110 00011100 00001000 00000000'),
  "W": glyph('01100011 01100011 01101011 01111111 01111111 01110111 01100011 00000000'),
  "X": glyph('11000011 11100111 11100111 11100111 11100111 11100111 11000011 11111111'),
  "Y": glyph('00110011 00110011 00110011 00011110 00001100 00001100 00001100 00000000'),
  "Z": glyph('11000001 11101011 11101011 11101011 11101011 11101011 11000001 11111111'),
  "-": glyph('00000000 00000000 00000000 01111110 01111110 00000000 00000000 00000000'),
  " ": glyph('00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000'),
  ".": glyph('00000000 00000000 00000000 00000000 00000000 00110000 00110000 00000000'),
  "!": glyph('00011100 00011100 00011100 00011100 00001000 00000000 00011100 00011100'),
  "©": glyph('00111100 01000010 10011101 10100001 10100001 10011101 01000010 00111100'),
  "Ⅰ": glyph('00111100 00011000 00011000 00011000 00011000 00011000 00111100 00000000'),
  "Ⅱ": glyph('00111110 00010100 00010100 00010100 00010100 00010100 00111110 00000000'),
};
const CITY_FONT: Readonly<Record<string, Bitmap>> = {
  C: [
    "00011110", "00110011", "01100000", "01100000",
    "01100000", "00110011", "00011110", "00000000"
  ],
  I: [
    "00111111", "00001100", "00001100", "00001100",
    "00001100", "00001100", "00111111", "00000000"
  ],
  T: [
    "00111111", "00001100", "00001100", "00001100",
    "00001100", "00001100", "00001100", "00000000"
  ],
  Y: [
    "00110011", "00110011", "00110011", "00011110",
    "00001100", "00001100", "00001100", "00000000"
  ]
};
export function drawText(g: PixelSurface, text: string, x: number, y: number, color = PALETTE.white): void {
  [...text.toUpperCase()].forEach((char, i) => drawBitmap(g, FONT[char] ?? FONT[' '], x + i * 8, y, { '1': color }));
}
interface BrickWordStyle {
  brick: number;
  mortar: number;
  brickEdge?: number;
}
export const GAMEOVER_BRICKS: BrickWordStyle = { brick: PALETTE.brick, mortar: PALETTE.gray, brickEdge: PALETTE.brickDark };
const HISCORE_BRICKS: BrickWordStyle = { brick: 0x4444fc, mortar: PALETTE.gray, brickEdge: PALETTE.brickDark };
// bank_FF.asm tbl_D565 palettes 05–08 vary color 1 ($0F/$12/$00/$30),
// retaining the dark-red edge ($06) and gray mortar ($00).
export const HISCORE_PALETTES: readonly BrickWordStyle[] = [
  PALETTE.black, HISCORE_BRICKS.brick, PALETTE.gray, PALETTE.white,
].map(brick => ({ ...HISCORE_BRICKS, brick }));
export function drawBrickWord(g: PixelSurface, text: string, x: number, y: number, city = false, scale = 4,
  style: BrickWordStyle = GAMEOVER_BRICKS): void {
  [...text].forEach((char, i) => {
    const glyphRows = FONT[char] ?? FONT[' '];
    const rows = city ? CITY_FONT[char] ?? glyphRows : glyphRows;
    rows.forEach((row, py) => {
      for (let sy = 0; sy < scale; sy++) {
        const dy = py * scale + sy;
        let start = 0, length = 0, runColor = 0;
        const flush = () => {
          if (length) { g.fillStyle(runColor); g.fillRect(x + start, y + dy, length, 1); length = 0; }
        };
        for (let px = 0; px < row.length; px++) {
          if (row[px] !== '1') { flush(); continue; }
          for (let sx = 0; sx < scale; sx++) {
            const dx = i * 8 * scale + px * scale + sx;
            const sample = BRICK_PATTERN[dy & 7][dx & 7];
            const color = sample === 'M' ? style.mortar : sample === 'D' ? style.brickEdge ?? PALETTE.brickDark : style.brick;
            if (length && (runColor !== color || start + length !== dx)) flush();
            if (!length) { start = dx; runColor = color; }
            length++;
          }
        }
        flush();
      }
    });
  });
}
export const NAMCOT: Bitmap = [
  "111111111....11111111...111111111111....11111111...11111111...111111111.", "1111111111...111111111..1111111111111..111111111..1111111111..111111111.", "111....111.........111..111..111..111..111........111....111.....111....", "111....111...111111111..111..111..111..111........111....111.....111....",
  "111....111..1111111111..111..111..111..111........111....111.....111....", "111....111..111....111..111..111..111..111........111....111.....111....", "111....111..1111111111..111..111..111..111111111..1111111111.....111....", "111....111...111111111..111..111..111...11111111...11111111......111...."
];
const PLAYER_FRAMES: readonly Readonly<Record<Direction, readonly Bitmap[]>>[] = [
  {
    up: [
      [
        "................", "................", ".......H........", ".......H........",
        ".HYY...H...HYY..", ".DDH...H...DDD..", ".HYH.HYHDD.DYY..", ".DDHHHYYYYDDDD..",
        ".HYHHYHHYYYDYY..", ".DDHHYHYDYYDDD..", ".HYHHYHYDYYDYY..", ".DDHHHYDDYYDDD..",
        ".HYHDHHYYYDDYY..", ".DDH.DDDDD.DDD..", ".HYY.......DYY..", "................"
      ],
      [
        "................", "................", ".......H........", ".......H........",
        ".HDD...H...HDD..", ".HYH...H...DYY..", ".DDH.HYHDD.DDD..", ".HYHHHYYYYDDYY..",
        ".DDHHYHHYYYDDD..", ".HYHHYHYDYYDYY..", ".DDHHYHYDYYDDD..", ".HYHHHYDDYYDYY..",
        ".DDHDHHYYYDDDD..", ".HYH.DDDDD.DYY..", ".YDD.......DDD..", "................"
      ]
    ],
    right: [
      [
        "................", ".HDHDHDHDHDH....", ".YDYDYDYDYDY....", ".YHHHHHHHHHY....",
        "...YHHHHH.......", "..HHYYYYHD......", "..HYHHHYYD......", "..YYHYYDYHHHHH..",
        "..YYYDDDYD......", "..YDYYYYYD......", "...DDDDDD.......", ".HDDDDDDDDDD....",
        ".YDYDYDYDYDY....", ".YDYDYDYDYDY....", "................", "................"
      ],
      [
        "................", ".HHDHDHDHDHY....", ".DYDYDYDYDYD....", ".DHHHHHHHHHD....",
        "...YHHHHH.......", "..HHYYYYHD......", "..HYHHHYYD......", "..YYHYYDYHHHHH..",
        "..YYYDDDYD......", "..YDYYYYYD......", "...DDDDDD.......", ".HDDDDDDDDDD....",
        ".DYDYDYDYDYD....", ".DYDYDYDYDYD....", "................", "................"
      ]
    ],
    down: [
      [
        "................", ".HYY.......HYY..", ".DDH.HHHHH.DDD..", ".HYHYHYYYYDDYY..",
        ".DDHHYHHYYYDDD..", ".HYHHYHYDYYDYY..", ".DDHHYHYDYYDDD..", ".HYHHYYDDYYDYY..",
        ".DDHHHYYYYDDDD..", ".HYH.DDHDD.DYY..", ".DDH...H...DDD..", ".HYY...H...DYY..",
        ".......H........", ".......H........", "................", "................"
      ],
      [
        "................", ".HDD.......HDD..", ".HYH.HHHHH.DYY..", ".DDHYHYYYYDDDD..",
        ".HYHHYHHYYYDYY..", ".DDHHYHYDYYDDD..", ".HYHHYHYDYYDYY..", ".DDHHYYDDYYDDD..",
        ".HYHHHYYYYDDYY..", ".DDH.DDHDD.DDD..", ".HYH...H...DYY..", ".YDD...H...DDD..",
        ".......H........", ".......H........", "................", "................"
      ]
    ],
    left: [
      [
        "................", "....HDHDHDHDHDH.", "....YDYDYDYDYDY.", "....YHHHHHHHHHD.",
        ".......HHHHHD...", "......HHYYYHHD..", "......YYHHHYHD..", "..HHHHHYHYYDYD..",
        "......DYYDDDYD..", "......DYYYYYDD..", ".......DDDDDD...", "....HDDDDDDDDDD.",
        "....YDYDYDYDYDY.", "....YDYDYDYDYDY.", "................", "................"
      ],
      [
        "................", "....HHDHDHDHDHY.", "....DYDYDYDYDYD.", "....DHHHHHHHHHD.",
        ".......HHHHHD...", "......HHYYYHHD..", "......YYHHHYHD..", "..HHHHHYHYYDYD..",
        "......DYYDDDYD..", "......DYYYYYDD..", ".......DDDDDD...", "....HDDDDDDDDDD.",
        "....DYDYDYDYDYD.", "....DYDYDYDYDYD.", "................", "................"
      ]
    ]
  },
  {
    up: [
      [
        ".......H........", ".......H........", ".......H........", ".......H........",
        ".HYY..DHD..HYY..", ".DDHHHDHDDDDDD..", ".HYYHHYHYDDDYY..", ".DDYHHYYYDDDDD..",
        ".HYYHYHHYYDDYY..", ".DDYHYHYDYDDDD..", ".HYYHYHYDYDDYY..", ".DDYHYHYDYDDDD..",
        ".HYYHYYDDYDDYY..", ".DDYHHYYYDDDDD..", ".HYHDDDDDDDDYY..", ".DDD.......DDD.."
      ],
      [
        ".......H........", ".......H........", ".......H........", ".......H........",
        ".YDD..DHD..HDD..", ".HYHHHDHDDDDYY..", ".DDYHHYHYDDDDD..", ".HYYHHYYYDDDYY..",
        ".DDYHYHHYYDDDD..", ".HYYHYHYDYDDYY..", ".DDYHYHYDYDDDD..", ".HYYHYHYDYDDYY..",
        ".DDYHYYDDYDDDD..", ".HYYHHYYYDDDYY..", ".DDHDDDDDDDDDD..", ".HYY.......YYY.."
      ]
    ],
    right: [
      [
        "................", "YHDHDHDHDHDH....", "DYDYDYDYDYDY....", "DHYYYYYYYYHY....",
        ".HHHHHHHHHH.....", ".HYYYYYYHHY.....", ".YYHHHHYYYYD....", ".YYHYYYDYHHHHHHH",
        ".YYYDDDDYYDD....", ".DYYYYYYDDD.....", ".DDDDDDDDDD.....", "YDDDDDDDDDDD....",
        "DYDYDYDYDYDY....", "DYDYDYDYDYDY....", "................", "................"
      ],
      [
        "................", "HDHDHDHDHDHY....", "YDYDYDYDYDYD....", "YHYYYYYYYYHD....",
        ".HHHHHHHHHH.....", ".HYYYYYYHHY.....", ".YYHHHHYYYYD....", ".YYHYYYDYHHHHHHH",
        ".YYYDDDDYYDD....", ".DYYYYYYDDD.....", ".DDDDDDDDDD.....", "HDDDDDDDDDDY....",
        "YDYDYDYDYDYD....", "YDYDYDYDYDYD....", "................", "................"
      ]
    ],
    down: [
      [
        ".DDD.......HDD..", ".HYHHHHHHHHDYY..", ".DDYHHYYYYDDDD..", ".HYYHYHHYYDDYY..",
        ".DDYHYHYDYDDDD..", ".HYYHYHYDYDDYY..", ".DDYHYHYDYDDDD..", ".HYYHYYDDYDDYY..",
        ".DDYHHYYYYDDDD..", ".HYYHHYHYDDDYY..", ".DDHHDDHDDDDDD..", ".HYY..DHD..YYY..",
        ".......H........", ".......H........", ".......H........", ".......H........"
      ],
      [
        ".HYY.......HYY..", ".DDHHHHHHHHDDD..", ".HYYHHYYYYDDYY..", ".DDYHYHHYYDDDD..",
        ".HYYHYHYDYDDYY..", ".DDYHYHYDYDDDD..", ".HYYHYHYDYDDYY..", ".DDYHYYDDYDDDD..",
        ".HYYHHYYYYDDYY..", ".DDYHHYHYDDDDD..", ".HYHHDDHDDDDYY..", ".YDD..DHD..YDD..",
        ".......H........", ".......H........", ".......H........", ".......H........"
      ]
    ],
    left: [
      [
        "................", "....HDHDHDHDHDHD", "....YDYDYDYDYDYD", "....YHYYYYYYYHHD",
        ".....HHHHHHHHYD.", ".....HHYYYYYYDD.", "....YYYYHHHHYYD.", "HHHHHHHYHYYYDYD.",
        "....DDYYYDDDDYD.", ".....DDYYYYYYDD.", ".....DDDDDDDDDD.", "....HDDDDDDDDDDD",
        "....YDYDYDYDYDYD", "....YDYDYDYDYDYD", "................", "................"
      ],
      [
        "................", "....HHDHDHDHDHDH", "....DYDYDYDYDYDY", "....DHYYYYYYYHYY",
        ".....HHHHHHHHYD.", ".....HHYYYYYYDD.", "....YYYYHHHHYYD.", "HHHHHHHYHYYYDYD.",
        "....DDYYYDDDDYD.", ".....DDYYYYYYDD.", ".....DDDDDDDDDD.", "....HDDDDDDDDDDD",
        "....DYDYDYDYDYDY", "....DYDYDYDYDYDY", "................", "................"
      ]
    ]
  },
  {
    up: [
      [
        "......HHY.......", "......HYY.......", ".......H........", ".YDD.HDHDD.HDD..",
        ".HYYDHDHDDDDDY..", ".DYHHYYYYYDDDD..", ".HYHYYHHYYYDDY..", ".DYHYYHYDYYDDD..",
        ".HYHYYHYDYYDDY..", ".DYHYYHYDYYDDD..", ".HYHYYHYDYYDDY..", ".DYHHYYDDYDDDD..",
        ".HYYHHYYYDDDDY..", ".DYYDDDDDDDDDD..", ".HYY.......DDY..", "................"
      ],
      [
        "......HHY.......", "......HYY.......", ".......H........", ".HHH.HDHDD.HYY..",
        ".DYYDHDHDDDDDD..", ".HYHHYYYYYDDDY..", ".DYHYYHHYYYDDD..", ".HYHYYHYDYYDDY..",
        ".DYHYYHYDYYDDD..", ".HYHYYHYDYYDDY..", ".DYHYYHYDYYDDD..", ".HYHHYYDDYDDDY..",
        ".DYYHHYYYDDDDD..", ".HYYDDDDDDDDDY..", ".DYY.......DDD..", "................"
      ]
    ],
    right: [
      [
        "................", ".HDHDHDHDHDHY...", ".YYYYYYYYYYYD...", ".YYYHHHHHHHYD...",
        "..HHHYYYYYHD....", "..HYYYYYYYYYY...", "..YYHHHHHYYYY.HH", "..YYHYYYYDYHHHHY",
        "..YYYDDDDDYDD.YY", "..DYYYYYYYYDD...", "..DDYYYYYYDD....", ".YDDDDDDDDDDD...",
        ".DDDDDDDDDDDD...", ".YDYDYDYDYDYD...", "................", "................"
      ],
      [
        "................", ".DHDHDHDHDHDH...", ".YYYYYYYYYYYH...", ".YYYHHHHHHHYH...",
        "..HHHYYYYYHD....", "..HYYYYYYYYYY...", "..YYHHHHHYYYY.HH", "..YYHYYYYDYHHHHY",
        "..YYYDDDDDYDD.YY", "..DYYYYYYYYDD...", "..DDYYYYYYDD....", ".YDDDDDDDDDDY...",
        ".DDDDDDDDDDDY...", ".DYDYDYDYDYYY...", "................", "................"
      ]
    ],
    down: [
      [
        "................", ".HYY.......YDY..", ".DYYHHHHHHYDDD..", ".HYYHHYYYYDDDY..",
        ".DYHHYHHYYYDDD..", ".HYHYYHYDYYDDY..", ".DYHYYHYDYYDDD..", ".HYHYYHYDYYDDY..",
        ".DYHYYHYDYYDDD..", ".HYHYYYDDYYDDY..", ".DYHHYYYYYDDDD..", ".HYYDDDHDDDDDY..",
        ".YDD.DDHDD.DDD..", ".......H........", "......HHY.......", "......YYY......."
      ],
      [
        "................", ".DYY.......YDD..", ".HYYHHHHHHYDDY..", ".DYYHHYYYYDDDD..",
        ".HYHHYHHYYYDDY..", ".DYHYYHYDYYDDD..", ".HYHYYHYDYYDDY..", ".DYHYYHYDYYDDD..",
        ".HYHYYHYDYYDDY..", ".DYHYYYDDYYDDD..", ".HYHHYYYYYDDDY..", ".DYYYDDHDDDDDD..",
        ".YYY.DDHDD.DDD..", ".......H........", "......HHY.......", "......YYY......."
      ]
    ],
    left: [
      [
        "................", "...YHDHDHDHDHDH.", "...DYYYYYYYYYYY.", "...DYHHHHHHHYYY.",
        "....DHYYYYYHHD..", "...HHYYYYYYYHD..", "HH.YYYHHHHHYYD..", "HYHHHYHYYYYDYD..",
        "YY.DDYYDDDDDYD..", "...DDYYYYYYYDD..", "....DDYYYYYDDD..", "...HDDDDDDDDDDD.",
        "...DDDDDDDDDDDD.", "...DYDYDYDYDYDY.", "................", "................"
      ],
      [
        "................", "...HDHDHDHDHDHD.", "...HYYYYYYYYYYY.", "...HYHHHHHHHYYY.",
        "....DHYYYYYHHD..", "...HHYYYYYYYHD..", "HH.YYYHHHHHYYD..", "HYHHHYHYYYYDYD..",
        "YY.DDYYDDDDDYD..", "...DDYYYYYYYDD..", "....DDYYYYYDDD..", "...HDDDDDDDDDDD.",
        "...YDDDDDDDDDDD.", "...YDYDYDYDYDYD.", "................", "................"
      ]
    ]
  },
  {
    up: [
      [
        ".......HY.......", ".HYY...HY...HYY.", ".DYHHHYHYDYYYDD.", ".HYYHHYHYDYYDYY.",
        ".DYYHHYHYDYYDYD.", ".HYYHHHHYYYDDYY.", ".DYYHYYYYYYDDYD.", ".HYYHYHHHYYDDYY.",
        ".DYYHYHYYDYDDYD.", ".HYYHYHYYDYDDYY.", ".DYYHYYDDDYDDYD.", ".HYYHYYYYYYDDYY.",
        ".DYYDDDDDDDYDYD.", ".HYDDDDDDDDDYDY.", ".DDD........DDD.", "................"
      ],
      [
        ".......HY.......", ".YDD...HY...HDD.", ".HYHHHYHYDYYYDY.", ".DYYHHYHYDYYDYD.",
        ".HYYHHYHYDYYDYY.", ".DYYHHHHYYYDDYD.", ".HYYHYYYYYYDDYY.", ".DYYHYHHHYYDDYD.",
        ".HYYHYHYYDYDDYY.", ".DYYHYHYYDYDDYD.", ".HYYHYYDDDYDDYY.", ".DYYHYYYYYYDDYD.",
        ".HYYDDDDDDDYDYY.", ".DYDDDDDDDDDYDD.", ".HYY........DYY.", "................"
      ]
    ],
    right: [
      [
        "................", ".YHDHDHDHDHDHDH.", ".DYYYYYYYYYYYYY.", ".DYYYYYYYYYYYYY.",
        "..HYHHHHHHHHHY..", "..HHYYYYYYHHYY..", "..HHYHHHYYHYYY..", "..HHYHYYDYHHHHHH",
        "..HHYHYYDYYYYYYY", "..HHYYDDDYYDDD..", "..HHYYYYYYYYDD..", "..HYDDDDDDDDYD..",
        ".YYDDDDDDDDDDYY.", ".DYYYYYYYYYYYDY.", ".DYDYDYDYDYDYDY.", "................"
      ],
      [
        "................", ".HDHDHDHDHDHDHY.", ".YYYYYYYYYYYYYD.", ".YHYYYYYYYYYYHD.",
        "..HHHHHHHHHHHY..", "..HHYYYYYYHHYY..", "..HHYHHHYYHYYY..", "..HHYHYYDYHHHHHH",
        "..HHYHYYDYYYYYYY", "..HHYYDDDYYDDD..", "..HHYYYYYYYYDD..", "..HYDDDDDDDDYD..",
        ".YYDDDDDDDDDDYY.", ".YDYYYYYYYYYYYD.", ".YDYDYDYDYDYDYD.", "................"
      ]
    ],
    down: [
      [
        ".DDD........DDD.", ".HYYHHHHHHHHYYY.", ".DYYYHHHHHHYDYD.", ".HYYHYYYYYYDDYY.",
        ".DYYHYHHHYYDDYD.", ".HYYHYHYYDYDDYY.", ".DYYHYHYYDYDDYD.", ".HYYHYYDDDYDDYY.",
        ".DYYHYYYYYYDDYD.", ".HYYHHHHYYYDDYY.", ".DYYHHDHYDYDDYD.", ".HYYHDDHYDDYDYY.",
        ".DYYDDDHYDDDYYD.", ".HYY...HY...YYY.", ".......HY.......", "................"
      ],
      [
        ".HYY........YYY.", ".DYYHHHHHHHHYYD.", ".HYYYHHHHHHYDYY.", ".DYYHYYYYYYDDYD.",
        ".HYYHYHHHYYDDYY.", ".DYYHYHYYDYDDYD.", ".HYYHYHYYDYDDYY.", ".DYYHYYDDDYDDYD.",
        ".HYYHYYYYYYDDYY.", ".DYYHHHHYYYDDYD.", ".HYYHHDHYDYDDYY.", ".DYYHDDHYDDYDYD.",
        ".HYYDDDHYDDDYYY.", ".DDD...HY...DDD.", ".......HY.......", "................"
      ]
    ],
    left: [
      [
        "................", ".HDHDHDHDHDHDHD.", ".YYYYYYYYYYYYYD.", ".YHYYYYYYYYYYDD.",
        "..HHHHHHHHHHDD..", "..HHHHYYYYYYDD..", "..YYYHYHHHYYDD..", "HHHHHHYHYYDYDD..",
        "YYYYYYYHYYDYDD..", "..DDDYYYDDDYDD..", "..YYYYYYYYYYDD..", "..YYYDDDDDDDYD..",
        ".HYDDDDDDDDDDYD.", ".YDYYYYYYYYYYDD.", ".YDYDYDYDYDYDYD.", "................"
      ],
      [
        "................", ".YHDHDHDHDHDHDH.", ".DYYYYYYYYYYYYY.", ".DHYYYYYYYYYYDY.",
        "..HHHHHHHHHHDD..", "..HHHHYYYYYYDD..", "..YYYHYHHHYYDD..", "HHHHHHYHYYDYDD..",
        "YYYYYYYHYYDYDD..", "..DDDYYYDDDYDD..", "..YYYYYYYYYYDD..", "..YYYDDDDDDDYD..",
        ".HYDDDDDDDDDDYD.", ".DDYYYYYYYYYYDY.", ".DYDYDYDYDYDYDY.", "................"
      ]
    ]
  }
];
export const PLAYER = PLAYER_FRAMES[0].up[0];
export const PLAYER_RIGHT = PLAYER_FRAMES[0].right[0];
const ENEMY_FRAMES: Readonly<Record<EnemyKind, Readonly<Record<Direction, readonly Bitmap[]>>>> = {
  basic: {
    up: [
      [
        ".......W........", ".......W........", ".......W........", ".WSS..SWC..WSS..",
        ".CCS.WSWCC.SCC..", ".WSSWWSWCCCSSS..", ".CCSWWSSSCCSCC..", ".WSSWSSCSSCSSS..",
        ".CCSWSCCWSCSCC..", ".WSSWSCWWSCSSS..", ".CCSWSSSSSCSCC..", ".WSSWWSSSCCSSS..",
        ".CCS.WSSCC.SCC..", ".WSS..CCC..SSS..", ".......S........", "................"
      ],
      [
        ".......W........", ".......W........", ".......W........", ".SCC..SWC..WCC..",
        ".WSS.WSWCC.SSS..", ".CCSWWSWCCCSCC..", ".WSSWWSSSCCSSS..", ".CCSWSSCSSCSCC..",
        ".WSSWSCCWSCSSS..", ".CCSWSCWWSCSCC..", ".WSSWSSSSSCSSS..", ".CCSWWSSSCCSCC..",
        ".WSS.WSSCC.SSS..", ".CCS..CCC..SCC..", ".......W........", "................"
      ]
    ],
    right: [
      [
        "................", "..WCWCWCWCWCW...", "..SCSCSCSCSCS...", "..SSSSSSSSSSS...",
        "....WWWWWWS.....", "...WWSSSSWSS....", "..WWSSCCSSSSS...", ".SWWSSCWWSWWWWWW",
        "..WWSSWWSSCCC...", "...SWSSSSCCC....", "....SCCCCCC.....", "..WSSSSSSSSSS...",
        "..SCSCSCSCSCS...", "..SCSCSCSCSCS...", "................", "................"
      ],
      [
        "................", "..CWCWCWCWCWS...", "..CSCSCSCSCSC...", "..SSSSSSSSSSC...",
        "....WWWWWWS.....", "...WWSSSSWSS....", "..WWSSCCSSSSS...", ".WWWSSCWWSWWWWWW",
        "..WWSSWWSSCCC...", "...SWSSSSCCC....", "....SCCCCCC.....", "..WSSSSSSSSSS...",
        "..CSCSCSCSCSC...", "..CSCSCSCSCSC...", "................", "................"
      ]
    ],
    down: [
      [
        ".......S........", ".WSS..WWW..WSS..", ".CCS.WWWSS.SCC..", ".WSSWWSSSSCSSS..",
        ".CCSWSSSSSCSCC..", ".WSSWSCCWSCSSS..", ".CCSWSCWWSCSCC..", ".WSSWSSWSSCSSS..",
        ".CCSWWSSSCCSCC..", ".WSSWSSWCCCSSS..", ".CCS.SCWCC.SCC..", ".WSS..CWC..SSS..",
        ".......W........", ".......W........", ".......W........", "................"
      ],
      [
        ".......W........", ".CCS..WWW..SCC..", ".WSS.WWWSS.SSS..", ".CCSWWSSSSCSCC..",
        ".WSSWSSSSSCSSS..", ".CCSWSCCWSCSCC..", ".WSSWSCWWSCSSS..", ".CCSWSSWSSCSCC..",
        ".WSSWWSSSCCSSS..", ".CCSWSSWCCCSCC..", ".WSS.SCWCC.SSS..", ".SCC..CWC..SCC..",
        ".......W........", ".......W........", ".......W........", "................"
      ]
    ],
    left: [
      [
        "................", "................", "...WCWCWCWCWCW..", "...SCSCSCSCSCS..",
        "...SSSSSSSSSSS..", ".....WWWWWWW....", "....WWWSSSSWW...", "...SSSSSCCSSSC..",
        "WWWWWWSCCWSSSCS.", "...CCCSSWWSSCC..", "....CCCSSSSCC...", ".....CCCCCCC....",
        "...WSSSSSSSSSS..", "...SCSCSCSCSCS..", "...SCSCSCSCSCS..", "................"
      ],
      [
        "................", "................", "...SWCWCWCWCWC..", "...CSCSCSCSCSC..",
        "...CSSSSSSSSSS..", ".....WWWWWWW....", "....WWWSSSSWW...", "...SSSSSCCSSSC..",
        "WWWWWWSCCWSSSCW.", "...CCCSSWWSSCC..", "....CCCSSSSCC...", ".....CCCCCCC....",
        "...WSSSSSSSSSS..", "...CSCSCSCSCSC..", "...CSCSCSCSCSC..", "................"
      ]
    ]
  },
  fast: {
    up: [
      [
        ".......W........", ".......W........", ".SC.WWCWCSS.SC..", ".CCWWWCWCSSSCC..",
        ".CCSWWCWCCCSCC..", "...SSWSWSCCS....", "...SWSSSSSCS....", ".SCSWSSCSSCSSC..",
        ".CCSWSCCWSCSCC..", ".CCSWSCWWSCSCC..", "...SWSSSSSCS....", "...SWWSSSWCS....",
        ".SCSSSWWWCCSSC..", ".CCSCCCCCCCSCC..", ".CC.CCCWCCC.CC..", "................"
      ],
      [
        ".......W........", ".......W........", ".CC.WWCWCSS.CC..", ".SCWWWCWCSSSSC..",
        ".CCSWWCWCCCSCC..", "...SSWSWSCCS....", "...SWSSSSSCS....", ".CCSWSSCSSCSCC..",
        ".SCSWSCCWSCSSC..", ".CCSWSCWWSCSCC..", "...SWSSSSSCS....", "...SWWSSSWCS....",
        ".CCSSSWWWCCSCC..", ".SCSCCCCCCCSSC..", ".CC.CCCSCCC.CC..", "................"
      ]
    ],
    right: [
      [
        "................", ".SCC..SCC..SCC..", ".CCC..CCC..CCC..", "..SSSSSSSSSSS...",
        ".WSSWWWWWWSSSS..", ".WWSWSSSSSWSSC..", ".WWWSSCCSSSCSC..", ".CWWSSCWWSWWWWWW",
        ".WWSSSWWSSSCCC..", ".WSCWSSSSSCCCC..", ".SSSCCCCCCCCSC..", "..SSSSSSSSSSS...",
        ".SCC..SCC..SCC..", ".CCC..CCC..CCC..", "................", "................"
      ],
      [
        "................", ".CSC..CSC..CSC..", ".CCC..CCC..CCC..", "..SSSSSSSSSSS...",
        ".WSSWWWWWWSSSS..", ".WWSWSSSSSWSSC..", ".WWWSSCCSSSCSC..", ".SWWSSCWWSWWWWWW",
        ".WWSSSWWSSSCCC..", ".WSCWSSSSSCCCC..", ".SSSCCCCCCCCSC..", "..SSSSSSSSSSS...",
        ".CSC..CSC..CSC..", ".CCC..CCC..CCC..", "................", "................"
      ]
    ],
    down: [
      [
        "................", ".SC.WWWCWWW.SC..", ".CCWWSSSSSSSCC..", ".CCWSSWWWCSSCC..",
        "...SWWSSSWCS....", "...SWSSSSSCS....", ".SCSWSCCWSCSSC..", ".CCSWSCWWSCSCC..",
        ".CCSWSSWSSCSCC..", "...SWSSSSSCS....", "...SSWSWSCCS....", ".SCSSCCWCCCSSC..",
        ".CCSSCCWCCSSCC..", ".CC.SSCWCSS.CC..", ".......W........", ".......W........"
      ],
      [
        "................", ".CC.WWWSWWW.CC..", ".SCWWSSSSSSSSC..", ".CCWSSWWWCSSCC..",
        "...SWWSSSWCS....", "...SWSSSSSCS....", ".CCSWSCCWSCSCC..", ".SCSWSCWWSCSSC..",
        ".CCSWSSWSSCSCC..", "...SWSSSSSCS....", "...SSWSWSCCS....", ".CCSSCCWCCCSCC..",
        ".SCSSCCWCCSSSC..", ".CC.SSCWCSS.CC..", ".......W........", ".......W........"
      ]
    ],
    left: [
      [
        "................", "................", "..SCC..SCC..SCC.", "..CCC..CCC..CCC.",
        "...WSSSSSSSSSS..", "..WWWSWWWWWWSCC.", "..WWWWSSSSSWSCC.", "..SSSSSSCCSSWCC.",
        "WWWWWWSCCWSSWCW.", "..CCCSSSWWSSWCC.", "..SCCCSSSSSWCCC.", "..SSCCCCCCCCCCC.",
        "...SSSSSSSSSSS..", "..SCC..SCC..SCC.", "..CCC..CCC..CCC.", "................"
      ],
      [
        "................", "................", "..CSC..CSC..CSC.", "..CCC..CCC..CCC.",
        "...WSSSSSSSSSS..", "..WWWSWWWWWWSCC.", "..WWWWSSSSSWSCC.", "..SSSSSSCCSSWCC.",
        "WWWWWWSCCWSSWCS.", "..CCCSSSWWSSWCC.", "..SCCCSSSSSWCCC.", "..SSCCCCCCCCCCC.",
        "...SSSSSSSSSSS..", "..CSC..CSC..CSC.", "..CCC..CCC..CCC.", "................"
      ]
    ]
  },
  power: {
    up: [
      [
        "......WWS.......", ".......W........", ".......W........", ".WSS..SWC..WSS..",
        ".CCS.WSWCC.SCC..", ".WSSWWSWCCCSSS..", ".CCSWWSSSCCSCC..", ".WSSWSSCSSCSSS..",
        ".CCSWSCCWSCSCC..", ".WSSWSCWWSCSSS..", ".CCSWSSSSSCSCC..", ".WSSWWSSSCCSSS..",
        ".CCS.WWSCC.SCC..", ".WSS.WWCCC.SSS..", ".CCS..SWC..SCC..", "................"
      ],
      [
        "......WWS.......", ".......W........", ".......W........", ".SCC..SWC..WCC..",
        ".WSS.WSWCC.SSS..", ".CCSWWSWCCCSCC..", ".WSSWWSSSCCSSS..", ".CCSWSSCSSCSCC..",
        ".WSSWSCCWSCSSS..", ".CCSWSCWWSCSCC..", ".WSSWSSSSSCSSS..", ".CCSWWSSSCCSCC..",
        ".WSS.WWSCC.SSS..", ".CCS.WWCCC.SCC..", ".WSS..SSC..SSS..", "................"
      ]
    ],
    right: [
      [
        "................", ".CWCWCWCWCWCW...", ".CSCSCSCSCSCS...", ".SSSSSSSSSSSS...",
        "....WWWWWWW.....", "..WWWSSSSWWW....", ".SWWSSCCSSSSS..W", ".WWSSSCWWSWWWWWW",
        ".CWSSSWWSSCCC..S", "..CCSSSSSCCC....", "....CCCCCCC.....", ".SSSSSSSSSSSS...",
        ".CSCSCSCSCSCS...", ".CSCSCSCSCSCS...", "................", "................"
      ],
      [
        "................", ".WCWCWCWCWCWS...", ".SCSCSCSCSCSC...", ".SSSSSSSSSSSC...",
        "....WWWWWWW.....", "..WWWSSSSWWW....", ".SWWSSCCSSSSS..W", ".SWSSSCWWSWWWWWW",
        ".CWSSSWWSSCCC..S", "..CCSSSSSCCC....", "....CCCCCCC.....", ".SSSSSSSSSSSS...",
        ".SCSCSCSCSCSC...", ".SCSCSCSCSCSC...", "................", "................"
      ]
    ],
    down: [
      [
        "CCS..SWS..SCC...", "WSS.WWSSS.SSS...", "CCS.WWSSC.SCC...", "WSSWWSSSCCSSS...",
        "CCSWSSSSSCSCC...", "WSSWSCCWSCSSS...", "CCSWSCWWSCSCC...", "WSSWSSWSSCSSS...",
        "CCSWWSSSCCSCC...", "WSSWWSWCCCSSS...", "CCS.SCWCC.SCC...", "WSS..CWC..SSS...",
        "......W.........", "......W.........", ".....WWS........", "................"
      ],
      [
        "WSS..SSS..WSS...", "CCS.WWSSS.SCC...", "WSS.WWSSC.SSS...", "CCSWWSSSCCSCC...",
        "WSSWSSSSSCSSS...", "CCSWSCCWSCSCC...", "WSSWSCWWSCSSS...", "CCSWSSWSSCSCC...",
        "WSSWWSSSCCSSS...", "CCSWWSWCCCSCC...", "WSS.SCWCC.SSS...", "SCC..CWC..SCC...",
        "......W.........", "......W.........", ".....WWS........", "................"
      ]
    ],
    left: [
      [
        "................", "................", "...WCWCWCWCWCWC.", "...SCSCSCSCSCSC.",
        "...SSSSSSSSSSSS.", ".....WWWWWWW....", "....WWWSSSSWWW..", "W..SSSSSCCSSWWS.",
        "WWWWWWSCCWSSSCW.", "S..CCCSSWWSSCCC.", "....CCCSSSSCCC..", ".....CCCCCCC....",
        "...WSSSSSSSSSSS.", "...SCSCSCSCSCSC.", "...SCSCSCSCSCSC.", "................"
      ],
      [
        "................", "................", "...SWCWCWCWCWCW.", "...CSCSCSCSCSCS.",
        "...CSSSSSSSSSSS.", ".....WWWWWWW....", "....WWWSSSSWWW..", "W..SSSSSCCSSWWS.",
        "WWWWWWSCCWSSSCS.", "S..CCCSSWWSSCCC.", "....CCCSSSSCCC..", ".....CCCCCCC....",
        "...WSSSSSSSSSSS.", "...CSCSCSCSCSCS.", "...CSCSCSCSCSCS.", "................"
      ]
    ]
  },
  armor: {
    up: [
      [
        ".WSS..WWS..WSS..", ".CCSSCWWSCSSCC..", ".WSSSSSWCSSSSS..", ".CCSWSSWCSSCCC..",
        ".WSSWSSWCWSCSS..", ".CCSWWSWCWCCCC..", ".WSSWWWWWWCCSS..", ".CCSWSSCSSCCCC..",
        ".WSSWSCCWSCCSS..", ".CCSWSCWWSCCCC..", ".WSSWSSSSSCCSS..", ".CCSWSSSSSCCCC..",
        ".WSSSCCCCCSCSS..", ".CCSCCCCCCCSCC..", ".WSS...S...CSS..", "................"
      ],
      [
        ".SCS..WWS..WCC..", ".WSSSCWWSCSSSS..", ".CCSSSSWCSSSCC..", ".WSSWSSWCSSCSS..",
        ".CCSWSSWCWSCCC..", ".WSSWWSWCWCCSS..", ".CCSWWWWWWCCCC..", ".WSSWSSCSSCCSS..",
        ".CCSWSCCWSCCCC..", ".WSSWSCWWSCCSS..", ".CCSWSSSSSCCCC..", ".WSSWSSSSSCCSS..",
        ".CCSSCCCCCSCCC..", ".WSSCCCCCCCSSS..", ".CCS...W...CCC..", "................"
      ]
    ],
    right: [
      [
        "................", "WCWCWCWCWCWCWCW.", "SCSCSCSCSCSCSCS.", "SSSSSSSSSSSSSCS.",
        ".WSWWWWWWWWWSS..", ".WWSSSSSWWSSSS..", ".WWSSCCSWCCCCWW.", "SWWSSCWWSWWWWWS.",
        ".WWSSWWSWCCCCSS.", ".WWSSSSSSWCCCC..", ".WSCCCCCCCSSCC..", "SSCCCCCCCCCCSCS.",
        "SCSCSCSCSCSCSCS.", "SCSCSCSCSCSCSCS.", "................", "................"
      ],
      [
        "................", "CWCWCWCWCWCWCWC.", "CSCSCSCSCSCSCSC.", "CSSSSSSSSSSSSCC.",
        ".WSWWWWWWWWWSS..", ".WWSSSSSWWSSSS..", ".WWSSCCSWCCCCWW.", "WWWSSCWWSWWWWWS.",
        ".WWSSWWSWCCCCSS.", ".WWSSSSSSWCCCC..", ".WSCCCCCCCSSCC..", "CSCCCCCCCCCCSCC.",
        "CSCSCSCSCSCSCSC.", "CSCSCSCSCSCSCSC.", "................", "................"
      ]
    ],
    down: [
      [
        ".WSS...S...WSS..", ".CCSWWWWWWWSCC..", ".WSSSWWWWWSCSS..", ".CCSWSSSSSCCCC..",
        ".WSSWSSSSSCCSS..", ".CCSWSCCWSCCCC..", ".WSSWSCWWSCCSS..", ".CCSWSSCSSCCCC..",
        ".WSSWWWWWWCCSS..", ".CCSWWCWCWCCCC..", ".WSSWCCWCCSCSS..", ".CCSWCCWCCSCCC..",
        ".WSSCCCWCCCSSS..", ".CCSCCWWWCCSCC..", ".WSS..WSS..SSS..", "................"
      ],
      [
        ".CCS...W...CCC..", ".WSSWWWWWWWSSS..", ".CCSSWWWWWSCCC..", ".WSSWSSSSSCCSS..",
        ".CCSWSSSSSCCCC..", ".WSSWSCCWSCCSS..", ".CCSWSCWWSCCCC..", ".WSSWSSCSSCCSS..",
        ".CCSWWWWWWCCCC..", ".WSSWWCWCWCCSS..", ".CCSWCCWCCSCCC..", ".WSSWCCWCCSCSS..",
        ".CCSCCCWCCCSCC..", ".WSSCCWWWCCSSS..", ".CCS..WSS..CCC..", "................"
      ]
    ],
    left: [
      [
        "................", "WCWCWCWCWCWCWCW.", "SCSCSCSCSCSCSCS.", "SSSSSSSSSSSSSSS.",
        ".SSWWWWWWWWWSC..", ".CSSSWWSSSSSCC..", "WWSSSSWSCCSSCC..", "WWWWWWWCCWSSCCS.",
        "SSCCCCWSWWSSCC..", ".CSSSWWSSSSSCC..", ".SSSSCCCCCCCSC..", "WSSCCCCCCCCCCSC.",
        "SCSCSCSCSCSCSCS.", "SCSCSCSCSCSCSCS.", "................", "................"
      ],
      [
        "................", "SWCWCWCWCWCWCWC.", "CSCSCSCSCSCSCSC.", "SSSSSSSSSSSSSSS.",
        ".SSWWWWWWWWWSC..", ".CSSSWWSSSSSCC..", "WWSSSSWSCCSSCC..", "WWWWWWWCCWSSCCW.",
        "SSCCCCWSWWSSCC..", ".CSSSWWSSSSSCC..", ".SSSSCCCCCCCSC..", "WSSCCCCCCCCCCSC.",
        "CSCSCSCSCSCSCSC.", "CSCSCSCSCSCSCSC.", "................", "................"
      ]
    ]
  }
};
export function tankBitmap(tank: Tank, frame: 0 | 1): Bitmap {
  const frames = tank.team === 'player' ? PLAYER_FRAMES[Math.max(0, Math.min(3, tank.stars))] : ENEMY_FRAMES[tank.kind];
  return frames[tank.direction][frame];
}
export function tankColors(tank: Tank, tick: number): Readonly<Record<string, number>> {
  if (tank.team === 'player') return tank.playerIndex === 0
    ? { Y: PALETTE.yellow, D: PALETTE.olive, H: 0xf8d878 }
    : { Y: PALETTE.playerGreen, D: PALETTE.playerGreenDark, H: 0xb8f8b8 };
  if (tank.carryingPowerUp && (tick & 8) !== 0) return { W: PALETTE.white, S: PALETTE.red, C: 0x440064 };
  if (tank.kind === 'armor') {
    if (tank.hp >= 4) return { W: 0xb8f8b8, S: PALETTE.playerGreen, C: PALETTE.playerGreenDark };
    if (tank.hp === 3 || tank.hp === 2) return { W: 0xf8d878, S: PALETTE.yellow, C: PALETTE.olive };
  }
  return { W: PALETTE.white, S: PALETTE.light, C: PALETTE.enemyDark };
}
export const SCORE_ENEMIES: readonly Bitmap[] = [
  [
    ".......W........", ".......W........", ".......W........", ".WSS..SWC..WSS..",
    ".CCS.WSWCC.SCC..", ".WSSWWSWCCCSSS..", ".CCSWWSSSCCSCC..", ".WSSWSSCSSCSSS..",
    ".CCSWSCCWSCSCC..", ".WSSWSCWWSCSSS..", ".CCSWSSSSSCSCC..", ".WSSWWSSSCCSSS..",
    ".CCS.WSSCC.SCC..", ".WSS..CCC..SSS..", ".......S........", "................"
  ],
  [
    ".......W........", ".......W........", ".SC.WWCWCSS.SC..", ".CCWWWCWCSSSCC..",
    ".CCSWWCWCCCSCC..", "...SSWSWSCCS....", "...SWSSSSSCS....", ".SCSWSSCSSCSSC..",
    ".CCSWSCCWSCSCC..", ".CCSWSCWWSCSCC..", "...SWSSSSSCS....", "...SWWSSSWCS....",
    ".SCSSSWWWCCSSC..", ".CCSCCCCCCCSCC..", ".CC.CCCWCCC.CC..", "................"
  ],
  [
    "......WWS.......", ".......W........", ".......W........", ".WSS..SWC..WSS..",
    ".CCS.WSWCC.SCC..", ".WSSWWSWCCCSSS..", ".CCSWWSSSCCSCC..", ".WSSWSSCSSCSSS..",
    ".CCSWSCCWSCSCC..", ".WSSWSCWWSCSSS..", ".CCSWSSSSSCSCC..", ".WSSWWSSSCCSSS..",
    ".CCS.WWSCC.SCC..", ".WSS.WWCCC.SSS..", ".CCS..SWC..SCC..", "................"
  ],
  [
    ".WSS..WWS..WSS..", ".CCSSCWWSCSSCC..", ".WSSSSSWCSSSSS..", ".CCSWSSWCSSCCC..",
    ".WSSWSSWCWSCSS..", ".CCSWWSWCWCCCC..", ".WSSWWWWWWCCSS..", ".CCSWSSCSSCCCC..",
    ".WSSWSCCWSCCSS..", ".CCSWSCWWSCCCC..", ".WSSWSSSSSCCSS..", ".CCSWSSSSSCCCC..",
    ".WSSSCCCCCSCSS..", ".CCSCCCCCCCSCC..", ".WSS...S...CSS..", "................"
  ]
];
export const EAGLE: Bitmap = [
  "................", "WW............WW", ".WW...WWW....WW.", "WWWW...WSW..WWWW",
  ".WWW...WW...WWW.", "WWWWWW.WW.WWWWWW", "..WSWWWWWWWWSW..", ".WWWSWWWWWWSWWW.",
  "..WWWWSWWSWWWW..", "..WWWWWWWWWWWW..", "...WWW.WW.WWW...", ".......WW.......",
  "......WWWW......", "....WWWWWWWW....", "....WW.WW.WW....", "................"
];
export const DESTROYED_BASE: Bitmap = [
  "................", "................", ".....S..........", "....SS.W........",
  "....S.WWW.......", "...S.WWWWW......", "..SS.WWWWWWWW...", "..S.WWWWWWWWWW..",
  ".SS.WWWWWWWWWW..", ".S..WWWWWWWW.WW.", ".S.WWWWWW..W.WW.", ".S...WWW.....W..",
  ".S.....W.....W..", ".S..............", ".S..............", ".S.............."
];
export const BASE_COLORS = { alive: { W: PALETTE.white, S: PALETTE.light }, dead: { W: PALETTE.white, S: PALETTE.gray } };
export const STEEL = ['LLLLLLLL','LLLLLLLD','LLWWWWDD','LLWWWWDD','LLWWWWDD','LLWWWWDD','LLDDDDDD','LDDDDDDD'];
const BRICK_PATTERN: Bitmap = [
  'DDDDMDDD', 'BBBBMDBB', 'BBBBMDBB', 'MMMMMMMM',
  'MDDDDDDD', 'MDBBBBBB', 'MDBBBBBB', 'MMMMMMMM',
];
export const BRICK_TILES: readonly Bitmap[] = Array.from({ length: 16 }, (_, mask) =>
  Array.from({ length: 8 }, (_, py) => Array.from({ length: 8 }, (_, px) => {
    const quarter = Math.floor(py / 4) * 2 + Math.floor(px / 4);
    if (!(mask & 1 << quarter)) return '.';
    return BRICK_PATTERN[py][px];
  }).join('')));
export const FOREST: Bitmap = [
  ".DDDDDL.", "DDDLDLDL", "DDDDDLLL", "DDDLLDDL",
  "DDLDLLLD", "DDDLLLLL", "LLLLLDLL", ".LLDLLL."
];
export const TERRAIN_COLORS = {
  water: { B: 0x4444fc, W: 0xb8f8f8, G: PALETTE.light },
  forest: { D: PALETTE.greenDark, L: PALETTE.green },
  ice: { G: PALETTE.gray, L: PALETTE.light, W: PALETTE.white },
};
export const WATER: readonly Bitmap[] = [
  [
    "BBBBBWBG", "BGBBBBBB", "WBGBBBBB", "BWBGWBGB",
    "BBBWBWBG", "BBBGBBBB", "BWGBGBBB", "GBWBBBWB"
  ],
  [
    "BBBBBWBB", "BBBBBBBB", "WBBBBBBB", "BWBBWBBB",
    "BBBWBWBB", "BBBBBBBB", "BWBBBBBB", "BBWBBBWB"
  ],
  [
    "BBBBBBBW", "BWBBBBBB", "BBWBBBBB", "BBBWBBWB",
    "BBBBBBBW", "BBBWBBBB", "BBWBWBBB", "WBBBBBBB"
  ]
];
export const ICE: Bitmap = [
  "GLLWGLLW", "LLLLLLWG", "LLLLLWGL", "WLLLWGLL",
  "GLLWGLLW", "LLWGLLWG", "LWGLLWGL", "WGLLWGLL"
];
export const SPAWN_FRAMES: readonly Bitmap[] = [
  [
    "................", "................", "................", ".......W........",
    ".......W........", ".......W........", "......WWW.......", "...WWWWWWWWW....",
    "......WWW.......", ".......W........", ".......W........", ".......W........",
    "................", "................", "................", "................"
  ],
  [
    "................", "................", ".......W........", ".......W........",
    ".......W........", "......WWW.......", ".....WWWWW......", "..WWWWWWWWWWW...",
    ".....WWWWW......", "......WWW.......", ".......W........", ".......W........",
    ".......W........", "................", "................", "................"
  ],
  [
    "................", ".......W........", ".......W........", ".......W........",
    "......WWW.......", "......WWW.......", "....WWWWWWW.....", ".WWWWWWWWWWWWW..",
    "....WWWWWWW.....", "......WWW.......", "......WWW.......", ".......W........",
    ".......W........", ".......W........", "................", "................"
  ],
  [
    ".......W........", ".......W........", ".......W........", "......WWW.......",
    "......WWW.......", ".....WWWWW......", "...WWWWWWWWW....", "WWWWWWWWWWWWWWW.",
    "...WWWWWWWWW....", ".....WWWWW......", "......WWW.......", "......WWW.......",
    ".......W........", ".......W........", ".......W........", "................"
  ]
];
export const SHIELD_FRAMES: readonly Bitmap[] = [
  [
    "......WWWW......", ".....W....W.....", "....W......W....", "....W......W....",
    "..WW........WW..", ".W............W.", "W..............W", "W..............W",
    "W..............W", "W..............W", ".W............W.", "..WW........WW..",
    "....W......W....", "....W......W....", ".....W....W.....", "......WWWW......"
  ],
  [
    "..WW........WW..", ".W..W......W..W.", "W....WW..WW....W", "W......WW......W",
    ".W............W.", "..W..........W..", "..W..........W..", "...W........W...",
    "...W........W...", "..W..........W..", "..W..........W..", ".W............W.",
    "W......WW......W", "W....WW..WW....W", ".W..W......W..W.", "..WW........WW.."
  ]
];
export const EXPLOSION_FRAMES: readonly Bitmap[] = [
  [
    "................", "................", ".......W.....W..", "...W...W..W.W...",
    "...DWW.DW.WWD...", "....DDWWDDWD....", ".....DWRWRWDWW..", "...WWWDWR.RDD...",
    ".....DW.RRWD....", ".....WWRWDRWD...", "....WD.WDWWDWD..", "...WD.DW.DW..W..",
    "......W...D.....", "................", "................", "................"
  ],
  [
    "................", "......D...W.....", ".W..D.WD.WD...W.", ".DWW..DW.WD.WWD.",
    "..DDWDDWWWDWDD..", "...DWRWWWDRWW.D.", ".D..DWR.RWWDD...", "...WWWWRRR.DWWW.",
    "WW.WDW.RR.WWDD..", "..DDWWDRRRWDD.D.", "....WRWD.DWRW...", "..D.DWRWWWRDWW..",
    "...DWDWDDWW.DDW.", "...WDDWD.DW...D.", "..WD..W.D.DD....", "................"
  ],
  [
    "....D.D....D..D.", ".W...W..W.D..WD.", ".DDWW..WW...WD..", "..DDWDDWDD.WWD..",
    "...DRWWWWDWWDD.D", ".W.DWWRW.WWRD...", "..DWWRDRR.RDWD..", "WWWW.WR..RWWWWWW",
    ".DDDWWDR.RWDDD..", "...DDD.WR.DDWW..", ".WDDWWDW.WRWDDW.", "..WWWRWDWDWW....",
    ".DWDDWDWWDDWW.D.", ".WD..D.DWD.DDW..", "WD..D...W....DW.", "........W.D...D."
  ],
  [
    "................................", ".....................W.......W..", "..W.......W..........W.......W..", "...W..W..W...DDD.WWD..W.....W...",
    "....D..W...WWWDDDWWDD.W.W..D....", ".....W.D..WDWWW.W..WDDW.W.WW....", "......W...WWDW.WDDD.WWWW.W......", "....WW...WWWWWWWWWDWWWWWW.W.....",
    ".......DDDW..WWWDWWDWW.DW....DW.", "......WDDDWWWWWDWW.WW.WWDW...W..", "D....WW.WDWWWRWWRWWWDWWWDWWW....", ".WD.DW.WWWRRWWWWRDWWWDWDW.WDW...",
    "..W.WW.WWWWRRWRWRWWRRDWW.WDDW...", ".W...WW.WDWRWRRRRRRWRWWWW.WW....", "..W.WDWWDDWWRWRWWRWRDWWWWW.WW...", "....DD.DWDWWRRWD.WRWWWW.W.WDD...",
    "......WWDWRRRW.WDW.RW.DWWW.DD...", ".....WWWWWWWRRWRDRRRWDDDWWWD..W.", ".....WW.WWWWRWRRDRWWRWW.WWDD...W", "....DW.WWDWRWWWRWRDWWWWWDDDD....",
    "....DDWDDDWWWWDRRWWWWDWWW.D.W...", "..W..DDDDWWWWDDWRWWWWWDWW.WW....", "...W....DW.WDDWWWW.WW.DW.WD.....", "........WW.WWW.WWWW..DDWWDD.....",
    "......WD.WW.W.DDWWWWDDWW.D......", ".....D.W.WWWWWDD..DDD.W.W.WW....", "....W......DDDD.........W..D....", "...W.....W........W..W.....WD...",
    "..D........W.......DWD......WD..", "..W................W.W.......W..", "................................", "................................"
  ],
  [
    "W...............................", "DW...W.............DDWW.......W.", ".DW...D.....WDDD.DWWWWDD....WD..", "..DD....WW.WWWD.DWWW..WDD..WD...",
    "...DD..WDWWWRWWW.WW.WD.WDD..D...", "...D..WWDDRDWWWWWWWWWWD.WD......", "......WDWWWWDWWWWWWDDWW.WD.WW...", "....DDWWWWWWWWWDDWWWWDWWWDDWWD..",
    "....DWWWW.WDDWWWWDWWWWWWDDWWDDD.", ".....WW..WWWWWRWWWWRWWWWDWW.WDD.", "...WWW.WWWRWWWRRWWRRWRWDWWWW.WD.", "..DWWWWWWWRRRWRWRRRWRWWWWDWW.WDW",
    "..WDWW.WWWR.RRWDRRWRWWWWWDW.WDDD", "...DW.DWWWWRWWR.RWRWWWRWDW.WDDW.", "...DD.DWWWWRRRRWDRRRWRWWWWWWD...", ".W.WWW.DWRRRRRWWW.WRWWWWWWDDWW..",
    ".WWWWWWWWWWRRD.WWRRRRWWWWDWWWDD.", "WWWRDWWWWRWRWWRDWWR.WRRRWWWWWWD.", "WWWWDWWWRWWRRRR.RRWRWWWWWWW.WWDW", "DWWDWRWWWWRRWRRWRRRRWWWWWDWW.WWD",
    "DDDDWWDDWRRDDWRRRWWRRWWDDWWWW.W.", ".DD.WWWWWWWWWWRWWWWWWRWWWDWW.WDW", ".....WWWWWWWDWWWWWWDWWWWWWWWW.WD", "....WW.WW.WWWWWWW.DD.WWWWWWWDWDW",
    "....WWW..DDWWWDWWW..WWWD.WW..DWW", "....WWWWWWDDWWW.WWWWDWWDD..WDDW.", "....DWWWWD.WWWW.WWWDDDWWDDDDDW..", "..W..DWDD..DDDWW.DDD.WRWWDDW....",
    "...W..DD......WWW...WWWDD....W..", "..D.D.....WD...WWWWWWWDDW..D.D..", ".W..D.......W...WWDDWDDD....D.W.", "W..........W.....DDD.D.........D"
  ]
];
export const IMPACT_FRAMES: readonly Bitmap[] = EXPLOSION_FRAMES.slice(0, 3);
export const BULLET_FRAMES: Readonly<Record<Direction, Bitmap>> = {
  up: [
    "........", "........", "........", "........",
    "........", "........", "....S...", "...SSS..",
    "...SSS..", "...SSS..", "........", "........",
    "........", "........", "........", "........"
  ],
  right: [
    "........", "........", "........", "........",
    "........", "........", "..SSS...", "..SSSS..",
    "..SSS...", "........", "........", "........",
    "........", "........", "........", "........"
  ],
  down: [
    "........", "........", "........", "........",
    "........", "........", "...SSS..", "...SSS..",
    "...SSS..", "....S...", "........", "........",
    "........", "........", "........", "........"
  ],
  left: [
    "........", "........", "........", "........",
    "........", "........", "...SSS..", "..SSSS..",
    "...SSS..", "........", "........", "........",
    "........", "........", "........", "........"
  ]
};
export const ITEM_COLORS = { W: PALETTE.white, S: PALETTE.light, C: PALETTE.enemyDark };
export const POWER_UP_BITMAPS: Readonly<Record<PowerUpKind, Bitmap>> = {
  helmet: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCCCCCCCCCCWC", "W.CCCCCCCCCCCCWC",
    "W.CCCWWWSS.CCCWC", "W.CCWWSSSSS.CCWC", "W.CCWSSSSSS.CCWC", "W.CCSSSSSSS.CCWC",
    "W.CSSSSSSSS.CCWC", "W.C.....SSSS.CWC", "W.CCCCCC.....CWC", "W.CCCCCCCCCCCCWC",
    "W.CCCCCCCCCCCCWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ],
  timer: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCCWSWS.CCCWC", "W.CCCCS...WS.CWC",
    "W.CCCSSSS....CWC", "W.CCSWWWWS.CCCWC", "W.CSWWCWWWS.CCWC", "W.CSWWCWWWS.CCWC",
    "W.CSWWWCWWS.CCWC", "W.C.SWWWWS.CCCWC", "W.CC.SSSS.CCCCWC", "W.CCC....CCCCCWC",
    "W.CCCCCCCCCCCCWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ],
  shovel: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCCCCCCWCCCWC", "W.CCCCCCCCWSCCWC",
    "W.CCCCCCCCSSSCWC", "W.CCCCCCCW...CWC", "W.CCCWCCW.CCCCWC", "W.CCWWSW.CCCCCWC",
    "W.CWWSCS.CCCCCWC", "W.CWSCSSS.CCCCWC", "W.CSSSSS.CCCCCWC", "W.CSSSS.CCCCCCWC",
    "W.C....CCCCCCCWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ],
  star: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCCCW.CCCCCWC", "W.CCCCWWS.CCCCWC",
    "W.CCCCWWS.CCCCWC", "W.WWWWWSSWWWW.WC", "W.CSSSWSWSSS..WC", "W.CCSWWWWSS..CWC",
    "W.CCWWSSWWS.CCWC", "W.CSWSS.SSWS.CWC", "W.CWSS...SSW.CWC", "W.CS...CC..S.CWC",
    "W.C..CCCCCC..CWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ],
  grenade: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCWWWSS.CCCWC", "W.CCCWSC..S.CCWC",
    "W.CCWSSSC..S.CWC", "W.CWSCWSCS.S.CWC", "W.CS.S..S..S.CWC", "W.CWSCWSCS.S.CWC",
    "W.CS.S..S..S.CWC", "W.CWSCWSCS..CCWC", "W.CCSC..S.CCCCWC", "W.CCCWSS.CCCCCWC",
    "W.CCC...CCCCCCWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ],
  tank: [
    ".WWWWWWWWWWWWWS.", "W.............WC", "W.CCCCCCCCCCCCWC", "W.CCCCCWSS.CCCWC",
    "W.CWWWWSSSC.CCWC", "W.C....SSSC.CCWC", "W.CCCWSSCCSC.CWC", "W.CCWSSSSSCC.CWC",
    "W.CSSWWWWSSSC.WC", "W.CSWS......S.WC", "W.C.W.W.W.WCS.WC", "W.CC.SSSSSSS.CWC",
    "W.CCC.......CCWC", "SWWWWWWWWWWWWWSC", ".CCCCCCCCCCCCCC.", "................"
  ]
};
export const POINT_BITMAPS: Readonly<Record<string, Bitmap>> = {
  "100": [
    "................", "................", "................", "................",
    "...W...WW...WW..", "..WW..W..W.W..W.", "...W..W..W.W..W.", "...W..W..W.W..W.",
    "...W..W..W.W..W.", "...W..W..W.W..W.", "..WWW..WW...WW..", "................",
    "................", "................", "................", "................"
  ],
  "200": [
    "................", "................", "................", "................",
    "..WW...WW...WW..", ".W..W.W..W.W..W.", "....W.W..W.W..W.", "...W..W..W.W..W.",
    "..W...W..W.W..W.", ".W....W..W.W..W.", ".WWWW..WW...WW..", "................",
    "................", "................", "................", "................"
  ],
  "300": [
    "................", "................", "................", "................",
    "..WW...WW...WW..", ".W..W.W..W.W..W.", "....W.W..W.W..W.", "..WW..W..W.W..W.",
    "....W.W..W.W..W.", ".W..W.W..W.W..W.", "..WW...WW...WW..", "................",
    "................", "................", "................", "................"
  ],
  "400": [
    "................", "................", "................", "................",
    "...W...WW...WW..", "..WW..W..W.W..W.", ".W.W..W..W.W..W.", ".W.W..W..W.W..W.",
    ".WWWW.W..W.W..W.", "...W..W..W.W..W.", "...W...WW...WW..", "................",
    "................", "................", "................", "................"
  ],
  "500": [
    "................", "................", "................", "................",
    ".WWWW..WW...WW..", ".W....W..W.W..W.", ".WWW..W..W.W..W.", "....W.W..W.W..W.",
    "....W.W..W.W..W.", ".W..W.W..W.W..W.", "..WW...WW...WW..", "................",
    "................", "................", "................", "................"
  ]
};
export const ENEMY_ICON: Bitmap = [
  "MMMMMMMM", "MBMMBMMB", "MBMBBBMB", "MBBBRBBB",
  "MBBBRBBB", "MBMBBBMB", "MBMMBMMB", "MMMBBBMM"
];
export const LIFE_ICON: Bitmap = [
  "MMMBBBMM", "MBMMBMMB", "MBMBBBMB", "MBBBMBBB",
  "MBBMMMBB", "MBBBMBBB", "MBMBBBMB", "MBMMBMMB"
];
export const FLAG: Bitmap = [
  "BBMMMMMMMMMMMMMM", "BBRRMMMMMMMMMMMM", "BBRRRRMMMMMMMMMM", "BBRRRRRRMMMMMMMM",
  "BBRRRRRRRRMMMMMM", "BBRRRRRRRRRRMMMM", "BBRRRRRRRRRRRRMM", "BBRRRRRRRRRRRRRR",
  "BBRRRRRRRRRRRRRR", "BBMMMMMMMMMMMMMM", "BBMMMMMMMMMMMMMM", "BBMMMMMMMMMMMMMM",
  "BBMMMMMMMMMMMMMM", "BBMMMMMMMMMMMMMM", "BBMMMMMMMMMMMMMM", "MMMMMMMMMMMMMMMM"
];
export const ARROW: Bitmap = [
  "....1...", "...11...", "..111111", ".1111111",
  "..111111", "...11...", "....1...", "........"
];
export const PAUSE: Bitmap = [
  ".RRRRRR....RRR...RR...RR..RRRR....RRRRRR", ".RR...RR..RR.RR..RR...RR.RR..RR...RR....", ".RR...RR.RR...RR.RR...RR.RR.......RR....", ".RR...RR.RR...RR.RR...RR..RRRRR...RRRRR.",
  ".RRRRRR..RRRRRRR.RR...RR......RR..RR....", ".RR......RR...RR.RR...RR.RR...RR..RR....", ".RR......RR...RR..RRRRR...RRRRR...RRRRRR", "........................................",
  "........................................", "........................................", "........................................", "........................................",
  "........................................", "........................................", "........................................", "........................................"
];
export const ARROW_RIGHT: Bitmap = [
  "....1...", "....11..", ".111111.", ".1111111",
  ".111111.", "....11..", "....1...", "........"
];
export const HUD_PLAYERS: readonly Bitmap[] = [
  [
    "MMBBBBMMMBBBBBBM", "MMMBBMMMMBBMMMBB", "MMMBBMMMMBBMMMBB", "MMMBBMMMMBBMMMBB",
    "MMMBBMMMMBBBBBBM", "MMMBBMMMMBBMMMMM", "MMBBBBMMMBBMMMMM", "MMMMMMMMMMMMMMMM"
  ],
  [
    "MMBBBBBMMBBBBBBM", "MMMBMBMMMBBMMMBB", "MMMBMBMMMBBMMMBB", "MMMBMBMMMBBMMMBB",
    "MMMBMBMMMBBBBBBM", "MMMBMBMMMBBMMMMM", "MMBBBBBMMBBMMMMM", "MMMMMMMMMMMMMMMM"
  ]
];
export const HUD_COLORS = { M: PALETTE.gray, B: PALETTE.black, R: PALETTE.brickDark };
export const FLAG_COLORS = { M: PALETTE.gray, B: PALETTE.black, R: PALETTE.brick };
export const LIFE_COLORS = { M: PALETTE.gray, B: PALETTE.brick };
