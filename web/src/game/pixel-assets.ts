import type { Direction, EnemyKind, PowerUpKind, Tank } from '../core/types';

/** Integer pixel shapes traced from the identified NES recording. RGB values are
 * approximate: the recording is cropped, scaled and compressed, not a ROM dump.
 * Source/evidence details live in the audit implementation report. */
export type Bitmap = readonly string[];
export interface PixelSurface {
  fillStyle(color: number, alpha?: number): unknown;
  fillRect(x: number, y: number, width: number, height: number): unknown;
}
export const PALETTE = {
  black: 0x000000, gray: 0x666666, light: 0xadadad, white: 0xfcfcfc,
  red: 0xbc3410, brick: 0xa05000, brickDark: 0x801000,
  yellow: 0xf8b800, olive: 0x687000, cyan: 0x3cbcfc,
  green: 0x80d010, greenDark: 0x005800,
};
export function rotateBitmap(rows: Bitmap, quarterTurns: number): string[] {
  let result = [...rows];
  for (let turn = 0; turn < ((quarterTurns % 4) + 4) % 4; turn++) {
    const height = result.length, width = result[0]?.length ?? 0;
    result = Array.from({ length: width }, (_, y) => Array.from({ length: height }, (_, x) => result[height - 1 - x][y]).join(''));
  }
  return result;
}
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
  ' ': glyph('00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000'),
  '0': glyph('00011100 00100110 01100011 01100011 01100011 00110010 00011100 00000000'),
  '1': glyph('00001100 00011100 00001100 00001100 00001100 00001100 00111111 00000000'),
  '2': glyph('00111110 01100011 00000111 00011110 00111100 01110000 01111111 00000000'),
  '3': glyph('00111110 01100011 00000011 00011110 00000011 01100011 00111110 00000000'),
  '4': glyph('00000110 00001110 00011110 00110110 01100110 01111111 00000110 00000000'),
  '5': glyph('01111110 01100000 01111110 00000011 00000011 01100011 00111110 00000000'),
  '6': glyph('00011110 00110000 01100000 01111110 01100011 01100011 00111110 00000000'),
  '7': glyph('01111111 01100011 00000110 00001100 00011000 00011000 00011000 00000000'),
  '8': glyph('00111100 01100010 01110010 00111100 01001111 01000011 00111110 00000000'),
  '9': glyph('00111110 01100011 01100011 00111111 00000011 00000110 00111100 00000000'),
  A: glyph('00011100 00110110 01100011 01100011 01111111 01100011 01100011 00000000'),
  B: glyph('01111110 01100011 01100011 01111110 01100011 01100011 01111110 00000000'),
  C: glyph('00011110 00110011 01100000 01100000 01100000 00110011 00011110 00000000'),
  D: glyph('01111100 01100110 01100011 01100011 01100011 01100110 01111100 00000000'),
  E: glyph('00111111 00110000 00110000 00111110 00110000 00110000 00111111 00000000'),
  F: glyph('00111111 00110000 00110000 00111110 00110000 00110000 00110000 00000000'),
  G: glyph('00011111 00110000 01100000 01100111 01100011 00110011 00011111 00000000'),
  H: glyph('01100011 01100011 01100011 01111111 01100011 01100011 01100011 00000000'),
  I: glyph('00111111 00001100 00001100 00001100 00001100 00001100 00111111 00000000'),
  // Original title tile $5F, CHR table $1000 (file offset $15F0).
  'Ⅱ': glyph('00111110 00010100 00010100 00010100 00010100 00010100 00111110 00000000'),
  J: glyph('00001111 00000011 00000011 00000011 01100011 01100011 00111110 00000000'),
  K: glyph('01100011 01100110 01101100 01111000 01101100 01100110 01100011 00000000'),
  L: glyph('00110000 00110000 00110000 00110000 00110000 00110000 00111111 00000000'),
  M: glyph('01100011 01110111 01111111 01111111 01101011 01100011 01100011 00000000'),
  N: glyph('01100011 01110011 01111011 01111111 01101111 01100111 01100011 00000000'),
  O: glyph('00111110 01100011 01100011 01100011 01100011 01100011 00111110 00000000'),
  P: glyph('01111110 01100011 01100011 01100011 01111110 01100000 01100000 00000000'),
  Q: glyph('00111110 01100011 01100011 01100011 01101011 01100110 00111101 00000000'),
  R: glyph('01111110 01100011 01100011 01100111 01111100 01101110 01100111 00000000'),
  S: glyph('00111100 01100110 01100000 00111110 00000011 01100011 00111110 00000000'),
  T: glyph('00111111 00001100 00001100 00001100 00001100 00001100 00001100 00000000'),
  U: glyph('01100011 01100011 01100011 01100011 01100011 01100011 00111110 00000000'),
  V: glyph('01100011 01100011 01100011 01110111 00111110 00011100 00001000 00000000'),
  W: glyph('01100011 01100011 01101011 01111111 01111111 01110111 01100011 00000000'),
  X: glyph('01100011 00110110 00011100 00001000 00011100 00110110 01100011 00000000'),
  Y: glyph('00110011 00110011 00110011 00011110 00001100 00001100 00001100 00000000'),
  Z: glyph('01111111 00000110 00001100 00011000 00110000 01100000 01111111 00000000'),
  '-': glyph('00000000 00000000 00000000 00111111 00000000 00000000 00000000 00000000'),
  '.': glyph('00000000 00000000 00000000 00000000 00000000 00110000 00110000 00000000'),
  '©': glyph('00111100 01000010 10011001 10100001 10100001 10011001 01000010 00111100'),
};
export function drawText(g: PixelSurface, text: string, x: number, y: number, color = PALETTE.white): void {
  [...text.toUpperCase()].forEach((char, i) => drawBitmap(g, FONT[char] ?? FONT[' '], x + i * 8, y, { '1': color }));
}
const CITY_FONT = {
  C: glyph('00111100 01100110 11000000 11000000 11000000 01100110 00111100 00000000'),
  I: glyph('01111110 00011000 00011000 00011000 00011000 00011000 01111110 00000000'),
  T: glyph('01111110 00011000 00011000 00011000 00011000 00011000 00011000 00000000'),
  Y: glyph('01100110 01100110 01100110 00111100 00011000 00011000 00011000 00000000'),
};
export interface BrickWordStyle {
  brick: number;
  mortar: number;
  brickEdge?: number;
}
export const GAMEOVER_BRICKS: BrickWordStyle = { brick: PALETTE.brick, mortar: PALETTE.light, brickEdge: PALETTE.brickDark };
export const HISCORE_BRICKS: BrickWordStyle = { brick: 0x4444fc, mortar: PALETTE.gray, brickEdge: PALETTE.brickDark };
// bank_FF.asm tbl_D565 palettes 05–08 vary color 1 ($0F/$12/$00/$30),
// retaining the dark-red edge ($06) and gray mortar ($00).
export const HISCORE_PALETTES: readonly BrickWordStyle[] = [
  PALETTE.black, HISCORE_BRICKS.brick, PALETTE.gray, PALETTE.white,
].map(brick => ({ ...HISCORE_BRICKS, brick }));
export function drawBrickWord(g: PixelSurface, text: string, x: number, y: number, city = false, scale = 4,
  style: BrickWordStyle = { brick: PALETTE.red, mortar: PALETTE.white }): void {
  [...text].forEach((char, i) => {
    const rows = (city ? CITY_FONT[char as keyof typeof CITY_FONT] : FONT[char]) ?? FONT[' '];
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
            const mortar = dy % 4 === 3 || (dx + (Math.floor(dy / 4) % 2) * 4) % 8 === 0;
            const color = mortar ? style.mortar : dy % 4 === 0 ? style.brickEdge ?? style.brick : style.brick;
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
  '111111111000011111111000111111111111000011111111000111111110001111111110',
  '111111111100011111111100111111111111100111111111001111111111001111111110',
  '111000011100000000011100111001110011100111000000001110000111000001110000',
  '111000011100011111111100111001110011100111000000001110000111000001110000',
  '111000011100111111111100111001110011100111000000001110000111000001110000',
  '111000011100111000011100111001110011100111000000001110000111000001110000',
  '111000011100111111111100111001110011100111111111001111111111000001110000',
  '111000011100011111111100111001110011100011111111000111111110000001110000',
];
const PLAYER_RIGHT = [
  '................', '.YDYDYDYDYDY....', '.YDYDYDYDYDY....', '.YYYYYYYYYYY....',
  '...YYYYYY.......', '..YYYYYYYD......', '..YYYYYYYD......', '..YYYYYDYYYYYY..',
  '..YYYDDDYD......', '..YDYYYYYD......', '...DDDDDD.......', '.YDDDDDDDDDD....',
  '.YDYDYDYDYDY....', '.YDYDYDYDYDY....', '................', '................',
];
export const PLAYER = rotateBitmap(PLAYER_RIGHT, 3);
// The four silhouettes are separately visible on the recording's Stage 36
// result screen. Their animation frames and upgrade variants remain unverified.
export const SCORE_ENEMIES: readonly Bitmap[] = [
  ['................','........W.......','........W.......','........W.......','..WSS..SWC..WSS.','..CCS.WSWCC.SCC.','..WSSWWSWCCCSSS.','..CCSWWSSSCCSCC.','..WSSWSSCSSCSSS.','..CCSWSCCWSCSCC.','..WSSWSCWWSCSSS.','..CCSWSSSSSCSCC.','..WSSWWSSSCCSSS.','..CCS.WSSCC.SCC.','..WSS..CCC..SSS.','........S.......'],
  ['................','........W.......','........W.......','..SC.WWCWCSS.SC.','..CCWWWCWCSSSCC.','..CCSWWCWCCCSCC.','....SSWSWSCCS...','....SWSSSSSCS...','..SCSWSSCSSCSSC.','..CCSWSCCWSCSCC.','..CCSWSCWWSCSCC.','....SWSSSSSCS...','....SWWSSSWCS...','..SCSSSWWWCCSSC.','..CCSCCCCCCCSCC.','..CC.CCCWCCC.CC.'],
  ['................','.......WWS......','........W.......','........W.......','..WSS..SWC..WSS.','..CCS.WSWCC.SCC.','..WSSWWSWCCCSSS.','..CCSWWSSSCCSCC.','..WSSWSSCSSCSSS.','..CCSWSCCWSCSCC.','..WSSWSCWWSCSSS.','..CCSWSSSSSCSCC.','..WSSWWSSSCCSSS.','..CCS.WWSCC.SCC.','..WSS.WWCCC.SSS.','..CCS..SWC..SCC.'],
  ['................','..WSS..WWS..WSS.','..CCSSCWWSCSSCC.','..WSSSSSWCSSSSS.','..CCSWSSWCSSCCC.','..WSSWSSWCWSCSS.','..CCSWWSWCWCCCC.','..WSSWWWWWWCCSS.','..CCSWSSCSSCCCC.','..WSSWSCCWSCCSS.','..CCSWSCWWSCCCC.','..WSSWSSSSSCCSS.','..CCSWSSSSSCCCC.','..WSSSCCCCCSCSS.','..CCSCCCCCCCSCC.','..WSS...S...CSS.'],
];
export const EAGLE: Bitmap = [
  '................', 'SS............SS', '.SS...SSS....SS.', 'SSSS...SRS..SSSS',
  '.SSS...SS...SSS.', 'SSSSSS.SS.SSSSSS', '..SRSSSSSSSSRS..', '.SSSRSSSSSSRSSS.',
  '..SSSSRSSRSSSS..', '..SSSSSSSSSSSS..', '...SSS.SS.SSS...', '.......SS.......',
  '......SSSS......', '....SSSSSSSS....', '....SS.SS.SS....', '................',
];
export const STEEL = ['LLLLLLLL','LLLLLLLD','LLWWWWDD','LLWWWWDD','LLWWWWDD','LLWWWWDD','LLDDDDDD','LDDDDDDD'];
export const BRICK_TILES: readonly Bitmap[] = Array.from({ length: 16 }, (_, mask) =>
  Array.from({ length: 8 }, (_, py) => Array.from({ length: 8 }, (_, px) => {
    const quarter = Math.floor(py / 4) * 2 + Math.floor(px / 4);
    if (!(mask & 1 << quarter)) return '.';
    const mortar = py % 4 === 3 || (px + (Math.floor(py / 4) + 1) % 2 * 4) % 8 === 0;
    return mortar ? 'M' : py % 4 === 2 ? 'D' : 'B';
  }).join('')));
export const FOREST = ['.DDDDDL.','DDDLDLDL','DDDDDLLL','DDDLLDDL','DDLDLLLD','DDDLLLLL','LLLLLDLL','.LLDLLL.'];
// Native-grid center samples from the cached original recording: Stage 31 water,
// Stage 6 forest and Stage 24 ice. Compression makes these RGB values approximate.
// The existing forest silhouette agrees with the sample; only its colors change.
export const TERRAIN_COLORS = {
  water: { B: 0x4854ff, W: 0xa5dfb6 },
  forest: { D: 0x004e0f, L: 0x8ac900 },
  ice: { G: 0xb3b3b3, W: 0xf3f2f3 },
};
export const WATER: readonly Bitmap[] = [
  ['BBBBBWBB','BBBBBBBB','WBBBBBBB','BWBBWBBB','BBBWBWBB','BBBBBBBB','BWBBBBBB','BBWBBBWB'],
  ['BBBBBBBW','BWBBBBBB','BBWBBBBB','BBBWBBWB','BBBBBBBW','BBBWBBBB','BBWBWBBB','WBBBBBBB'],
];
export const ICE: Bitmap = ['GGGWGGGW','GGGGGGWG','GGGGGWGG','WGGGWGGG','GGGWGGGW','GGWGGGWG','GWGGGWGG','WGGGWGGG'];
// White shield edge traced at native pixel centers around the Stage 1 player.
// Its transparent center leaves the unverified tank silhouettes untouched.
export const SHIELD: Bitmap = [
  '..WW........WW..', '.W..W......W..W.', 'W....WW..WW....W', 'W......WW......W',
  '.W............W.', '..W..........W..', '..W..........W..', '...W........W...',
  '...W........W...', '..W..........W..', '..W..........W..', '.W............W.',
  'W......WW......W', 'W....WW..WW....W', '.W..W......W..W.', '..WW........WW..',
];
export const ENEMY_ICON = ['........','.B..B..B','.B.BBB.B','.BBBRBBB','.BBBRBBB','.B.BBB.B','.B..B..B','...BBB..'];
export const LIFE_ICON = ['...YYY..','.Y.YY..Y','.Y.YYY.Y','.YYY.YYY','.YY...YY','.YYY.YYY','.Y.YYY.Y','.Y..Y..Y'];
export const FLAG = ['BB..............','BBRR............','BBRRRR..........','BBRRRRRR........','BBRRRRRRRR......','BBRRRRRRRRRR....','BBRRRRRRRRRRRR..','BBRRRRRRRRRRRRRR','BBRRRRRRRRRRRRRR','BB..............','BB..............','BB..............','BB..............','BB..............','BB..............','................'];
export function directionalBitmap(rows: Bitmap, direction: Direction): Bitmap {
  return rotateBitmap(rows, ['up', 'right', 'down', 'left'].indexOf(direction));
}

// Additional project-authored state frames. Their state selection is explicit;
// unlike the traced static samples above, pixel-exact original matching has not
// been established for these upgrade, tread, effect and item variants.
const UPGRADED_PLAYERS: readonly Bitmap[] = [PLAYER,
  ['.......YY.......','.......YY.......','.......YY.......','.YDY...YY...YDY.',
   '.YDY...YY...YDY.','.YYY.YYYYYY.YYY.','.YDY.YHHHHY.YDY.','.YDY.YHDDHY.YDY.',
   '.YYY.YHDDHY.YYY.','.YDY.YHDDHY.YDY.','.YDY.YHHHHY.YDY.','.YYY.YYYYYY.YYY.',
   '.YDY.DYYYYD.YDY.','.YDY.DDDDDD.YDY.','.YYY........YYY.','................'],
  ['.......YY.......','.......YY.......','.YDY...YY...YDY.','.YDY...YY...YDY.',
   '.YYY.YYYYYY.YYY.','.YDY.YHHHHY.YDY.','.YDY.YHHHHY.YDY.','.YYY.YHDDHY.YYY.',
   '.YDY.YHDDHY.YDY.','.YDY.YHDDHY.YDY.','.YYY.YHHHHY.YYY.','.YDY.YYYYYY.YDY.',
   '.YDY.YYYYYY.YDY.','.YYY.DDDDDD.YYY.','.YDY........YDY.','................'],
  ['.......YY.......','.YDY...YY...YDY.','.YDY...YY...YDY.','.YYY...YY...YYY.',
   '.YDY.YYYYYY.YDY.','.YDY.YHHHHY.YDY.','.YYY.YHDDHY.YYY.','.YDY.YHDDHY.YDY.',
   '.YDY.YHDDHY.YDY.','.YYY.YHHHHY.YYY.','.YDY.YYYYYY.YDY.','.YDY.YDDDDY.YDY.',
   '.YYY.YHHHHY.YYY.','.YDY.YYYYYY.YDY.','.YDY.DDDDDD.YDY.','................'],
];
function treadVariant(rows: Bitmap, player: boolean): Bitmap {
  return rows.map((row, y) => [...row].map((pixel, x) => {
    if (pixel === '.' || y < 3 || y > 14 || ![1, 2, 13, 14].includes(x)) return pixel;
    return player ? (y % 3 === 0 ? 'D' : 'Y') : (y % 3 === 0 ? 'C' : 'S');
  }).join(''));
}
export const PLAYER_TANK_FRAMES: readonly (readonly Bitmap[])[] = UPGRADED_PLAYERS.map(rows => [rows, treadVariant(rows, true)]);
export const ENEMY_TANK_FRAMES: Readonly<Record<EnemyKind, readonly Bitmap[]>> = {
  basic: [SCORE_ENEMIES[0], treadVariant(SCORE_ENEMIES[0], false)],
  fast: [SCORE_ENEMIES[1], treadVariant(SCORE_ENEMIES[1], false)],
  power: [SCORE_ENEMIES[2], treadVariant(SCORE_ENEMIES[2], false)],
  armor: [SCORE_ENEMIES[3], treadVariant(SCORE_ENEMIES[3], false)],
};
export function tankBitmap(tank: Tank, frame: 0 | 1): Bitmap {
  const frames = tank.team === 'player' ? PLAYER_TANK_FRAMES[Math.max(0, Math.min(3, tank.stars))] : ENEMY_TANK_FRAMES[tank.kind];
  return directionalBitmap(frames[frame], tank.direction);
}
export function tankColors(tank: Tank, tick: number): Readonly<Record<string, number>> {
  if (tank.team === 'player') return tank.playerIndex === 0
    ? { Y: PALETTE.yellow, D: PALETTE.olive, H: 0xf8d878 }
    : { Y: PALETTE.green, D: PALETTE.greenDark, H: 0xb8f878 };
  if (tank.carryingPowerUp && tick % 20 < 10) return { W: PALETTE.red, S: PALETTE.brickDark, C: PALETTE.brick };
  if (tank.kind === 'armor') {
    // Separate remaining-hit colors; flashes retain priority over armor damage.
    if (tank.hp >= 4) return { W: PALETTE.green, S: PALETTE.greenDark, C: 0xb8f878 };
    if (tank.hp === 3) return { W: PALETTE.yellow, S: PALETTE.olive, C: 0xf8d878 };
    if (tank.hp === 2) return { W: PALETTE.light, S: PALETTE.gray, C: PALETTE.white };
  }
  return { W: PALETTE.white, S: PALETTE.light, C: PALETTE.cyan };
}

export const BULLET: Bitmap = ['.W..', 'WWW.', '.W..', '.D..'];
export const IMPACT_FRAMES: readonly Bitmap[] = [
  ['........','...Y....','..YWY...','.YWWWY..','..YWY...','...Y....','........','........'],
  ['...Y....','.Y.Y.Y..','..YWW...','YYWWWYY.','..WWY...','.Y.Y.Y..','...Y....','........'],
  ['Y......Y','..Y..Y..','...YY...','..Y..Y..','..Y..Y..','...YY...','.Y....Y.','Y......Y'],
];
export const SPAWN_FRAMES: readonly Bitmap[] = [
  ['................','................','................','.......YY.......','.......YY.......','.......YY.......',
   '......YYYY......','...YYYYYYYYYY...','...YYYYYYYYYY...','......YYYY......','.......YY.......','.......YY.......',
   '.......YY.......','................','................','................'],
  ['................','.......YY.......','..Y....YY....Y..','...Y...YY...Y...','....Y..YY..Y....','.....YYYYYY.....',
   '......YYYY......','.YYYYYYYYYYYYYY.','.YYYYYYYYYYYYYY.','......YYYY......','.....YYYYYY.....','....Y..YY..Y....',
   '...Y...YY...Y...','..Y....YY....Y..','.......YY.......','................'],
  ['Y......YY......Y','.Y.....YY.....Y.','..Y....YY....Y..','...Y...YY...Y...','....YYYYYYYY....','....YWWWWWWY....',
   '....YWWWWWWY....','YYYYYWWWWWWYYYYY','YYYYYWWWWWWYYYYY','....YWWWWWWY....','....YWWWWWWY....','....YYYYYYYY....',
   '...Y...YY...Y...','..Y....YY....Y..','.Y.....YY.....Y.','Y......YY......Y'],
];
export const EXPLOSION_FRAMES: readonly Bitmap[] = [
  ['................','.......Y........','....Y..YY.......','.....YYWYY..Y...','...YYYYWWYYY....','....YWWWWWY.....',
   '..YYWWWWWWWYY...','.YYWWWWWWWWWY...','...YWWWWWWWYY...','..YYWWWWWWWY....','....YYWWWYYYY...', '...Y.YYWYY..Y...',
   '......YYY.......','......Y.Y.......','................','................'],
  ['........................','...........R............','....R......RY.....R.....','.....RY...RYY...YR......','......YYRYYWYYYRY.......',
   '.......YYWWWWWYY........','.....YYYWWWWWWWYYY......','...RYYWWWWWWWWWWWYYR....','.....YYWWWWWWWWWYY......','..RYYYYWWWWWWWWWYYYYR...',
   '...YYWWWWWWWWWWWWWYY....','.RYYWWWWWWWWWWWWWWWYYR..','..YYWWWWWWWWWWWWWWWYY...','....YYYYWWWWWWWYYYY.....','.....YYWWWWWWWWWYY......',
   '...RYYWWWWWWWWWWWYYR....','.....YYYWWWWWWWYYY......','.......YYWWWWWYY........','......YYRYYWYYYRY.......','.....RY...RYY...YR......',
   '....R......RY.....R.....','...........R............','........................','........................'],
  ['................................','...R..........R.............R...','....RY........RY..........YR....','.....RY.......RYY........YR.....',
   '......RYYR...RYYYR...RYYYR......','.......RYYYYRYYWWYYRYYYYR.......','........YYWWWWWWWWWWWWYY........','.....RYYYWWWWWWWWWWWWWWYYYR.....',
   '......YYWWWWWWWWWWWWWWWWYY......','....RYYYWWWWWWWWWWWWWWWWYYYR....','..RYYYYWWWWWWWWWWWWWWWWWWYYYYR..','...YYWWWWWWWWWWWWWWWWWWWWWWYY...',
   '....YYWWWWWWWWWWWWWWWWWWWWYY....','.RYYYWWWWWWWWWWWWWWWWWWWWWWYYYR.','..YYWWWWWWWWWWWWWWWWWWWWWWWWYY..','RYYWWWWWWWWWWWWWWWWWWWWWWWWWWYYR',
   '.YYWWWWWWWWWWWWWWWWWWWWWWWWWWYY.','..RYYYYWWWWWWWWWWWWWWWWWWYYYYR..','....YYWWWWWWWWWWWWWWWWWWWWYY....','...YYYWWWWWWWWWWWWWWWWWWWWYYY...',
   '..RYYYYWWWWWWWWWWWWWWWWWWYYYYR..','.....YYYWWWWWWWWWWWWWWWWYYY.....','......YYWWWWWWWWWWWWWWWWYY......','....RYYYYWWWWWWWWWWWWWWYYYYR....',
   '......RYYYWWWWWWWWWWWWYYYR......','........RYYYYYYWWYYYYYYR........','.......RYYYR..RYYR..RYYYR.......','......RYY......YY......YYR......',
   '.....RY........RY........YR.....','....R..........R..........R.....','................................','................................'],
];
export const DESTROYED_BASE: Bitmap = [
  '................','................','..S..........S..','...SS......SS...','....SS....SS....','..SSSS....SSSS..',
  '...SRSS..SSRS...','....SRSSSSRS....','..SSSSRSSRSSSS..','...SSSSSSSSSS...','....SSSSSSSS....','..SSSS.SS.SSSS..',
  '...S..SSSS..S...','....SSSSSSSS....','..SS..SSSS..SS..','................',
];
function itemFrame(icon: readonly string[]): Bitmap {
  return ['WWWWWWWWWWWWWWWW', 'W..............W', ...icon.map(row => 'W.' + row + '.W'), 'W..............W', 'WWWWWWWWWWWWWWWW'];
}
export const POWER_UP_BITMAPS: Readonly<Record<PowerUpKind, Bitmap>> = {
  star: itemFrame(['.....WW.....','.....WW.....','....WWWW....','WWWWWWWWWWWW','.WWWWWWWWWW.','..WWWWWWWW..',
    '...WWWWWW...','..WWWWWWWW..','..WWW..WWW..','.WWW....WWW.','.WW......WW.','............']),
  helmet: itemFrame(['............','....WWWW....','..WWWWWWWW..','.WWWWWWWWWW.','.WWWWWWWWWW.','.WWWWWWWWWW.',
    '.WWWWWWWWWW.','.WWWWWWWWWW.','WWWWWWWWWWWW','............','............','............']),
  timer: itemFrame(['....WWWW....','..WW....WW..','.W........W.','.W....W...W.','W.....W....W','W.....W....W',
    'W.....WWW..W','W..........W','.W........W.','.W........W.','..WW....WW..','....WWWW....']),
  shovel: itemFrame(['....WWWW....','...WWWWWW...','...WWWWWW...','...WWWWWW...','....WWWW....','.....WW.....',
    '.....WW.....','.....WW.....','.....WW.....','....WWWW....','....W..W....','....WWWW....']),
  grenade: itemFrame(['....WWWW....','....W..W....','.....WW.....','...WWWWWW...','..WW.WW.WW..','..W.WW.WWW..',
    '..WW.WW.WW..','..W.WW.WWW..','..WW.WW.WW..','..WWWWWWWW..','...WWWWWW...','............']),
  tank: itemFrame(['.....WW.....','.....WW.....','W....WW....W','W..WWWWWW..W','WW.WWWWWW.WW','WW.WW..WW.WW',
    'WW.WW..WW.WW','WW.WWWWWW.WW','WW.WWWWWW.WW','W..WWWWWW..W','W..........W','............']),
};
