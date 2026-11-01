// Node 24 built-ins only: generate shared game data without external assets or npm install.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks, stripTypeScriptTypes} from 'node:module';
import {deflateSync} from 'node:zlib';

if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24 or newer is required');
const web = new URL('../web/src/', import.meta.url).href;
// Reuse Web's decoder, including its one runtime enum and extensionless imports.
registerHooks({
  resolve(s, c, next) {return next(c.parentURL?.startsWith(web) && s.startsWith('.') && !s.split('/').at(-1).includes('.') ? s + '.ts' : s, c);},
  load(url, c, next) {
    if (url === web + 'core/types.ts') return {format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {mode: 'transform'}), shortCircuit: true};
    return next(url, c);
  },
});
const P = await import(web + 'game/pixel-assets.ts');
const {getLevel} = await import(web + 'data/levels.ts');
const A = await import(web + 'platform/audio-cues.ts');
const CREDITS = [
  "........Y.......", "........Y.......", "........Y.......", ".......YY.......",
  ".......YY.......", "......YYYY......", ".....YYYYYY.....", "....YHHYYYYY....",
  "....HHYYYYYY....", "...YYYYYYYYYD...", "...YHHYYYYYYD...", "...YHHYYYYYYD...",
  "...YYYYYYYYYD...", "...YYYYYYYYDD...", "....YYYYYYDD....", ".....YYDDDD....."
];

const DEMO_ROWS = [
  '..........................','..........................',
  '..........................','SS..........SS..........SS',
  '..........................','..........................',
  '..........................','..........................',
  '..........................','..........................',
  '..........................','..........................',
  '..........................','..........................',
  '..........................','..........................',
  '..........................','..........................',
  'FF......................FF','FF......................FF',
  'FFFF..................FFFF','FFFF..................FFFF',
  'SSFFFF..............FFFFSS','SSFFFF.....BBBB.....FFFFSS',
  'SSSSFFFF...B..B...FFFFSSSS','SSSSFFFF...B..B...FFFFSSSS',
];
const args = process.argv.slice(2), index = args.indexOf('--output');
if (index < 0 || !args[index + 1] || args.some((v, i) => i !== index + 1 && !['--output', '--check'].includes(v))) throw Error('Usage: node tools/export-android.mjs --output DIRECTORY [--check]');
const output = resolve(args[index + 1]), check = args.includes('--check');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!output.startsWith(join(repository, 'build') + '/')) throw Error('Generated Android data must be inside this checkout\'s build/ directory');
function save(name, data) {
  const target = join(output, name), bytes = Buffer.from(data);
  if (check) {if (!readFileSync(target).equals(bytes)) throw Error('Outdated generated data: ' + name);}
  else {mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);}
}
const palette = P.PALETTE, frames = new Map();
function frame(name, width, height, paint) {
  if (frames.has(name) || width <= 0 || height <= 0) throw Error('Invalid frame ' + name);
  const pixels = Buffer.alloc(width * height * 4); let color = 0;
  const surface = {
    fillStyle(value, alpha = 1) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffff || alpha !== 1) throw Error('Expected opaque RGB');
      color = value; return this;
    },
    fillRect(left, top, w, h) {
      if (![left, top, w, h].every(Number.isInteger) || w < 0 || h < 0) throw Error('Expected integer rectangles');
      for (let y = Math.max(0, top); y < Math.min(height, top + h); y++) for (let x = Math.max(0, left); x < Math.min(width, left + w); x++) {
        const i = (y * width + x) * 4; pixels[i] = color >>> 16; pixels[i + 1] = color >>> 8; pixels[i + 2] = color; pixels[i + 3] = 255;
      }
      return this;
    },
  };
  paint(surface); const f = {name, width, height, pixels}; frames.set(name, f); return f;
}
function bitmap(name, rows, colors, width = rows[0].length, height = rows.length) {
  if (rows.some(row => row.length !== rows[0].length) || rows[0].length > width || rows.length > height) throw Error('Malformed bitmap ' + name);
  if (rows.some(row => [...row].some(c => !['.', '0'].includes(c) && colors[c] === undefined))) throw Error('Unknown bitmap color in ' + name);
  return frame(name, width, height, g => {
    P.drawBitmap(g, rows, Math.floor((width - rows[0].length) / 2), Math.floor((height - rows.length) / 2), colors);
  });
}
const directions = ['up', 'right', 'down', 'left'], kinds = ['basic', 'fast', 'power', 'armor'];
for (let p = 0; p < 2; p++) for (let stars = 0; stars < 4; stars++) for (const direction of directions) for (let tread = 0; tread < 2; tread++) {
  const tank = {team: 'player', playerIndex: p, stars, direction};
  bitmap(`player:${p}:${stars}:${direction}:${tread}`, P.tankBitmap(tank, tread), P.tankColors(tank, 10));
}
for (const kind of kinds) for (const variant of (kind === 'armor' ? ['flash', 'hp1', 'hp2', 'hp3', 'hp4'] : ['normal', 'flash'])) for (const direction of directions) for (let tread = 0; tread < 2; tread++) {
  const tank = {team: 'enemy', kind, hp: variant.startsWith('hp') ? Number(variant.slice(2)) : 1, carryingPowerUp: variant === 'flash', direction};
  bitmap(`enemy:${kind}:${variant}:${direction}:${tread}`, P.tankBitmap(tank, tread), P.tankColors(tank, variant === 'flash' ? 8 : 10));
}
for (let mask = 1; mask < 16; mask++) bitmap('brick:' + mask, P.BRICK_TILES[mask], {M: palette.gray, D: palette.brickDark, B: palette.brick});
bitmap('steel', P.STEEL, {L: palette.light, D: palette.gray, W: palette.white});
bitmap('forest', P.FOREST, P.TERRAIN_COLORS.forest); bitmap('ice', P.ICE, P.TERRAIN_COLORS.ice);
for (const phase of [1, 2]) bitmap('water:' + phase, P.WATER[phase], P.TERRAIN_COLORS.water);
bitmap('base:alive', P.EAGLE, P.BASE_COLORS.alive);
bitmap('base:dead', P.DESTROYED_BASE, P.BASE_COLORS.dead);
if (P.SPAWN_FRAMES.length !== 4 || P.SHIELD_FRAMES.length !== 2 || P.EXPLOSION_FRAMES.length !== 5) throw Error('Incomplete animation frames');
P.SPAWN_FRAMES.forEach((rows, i) => bitmap('spawn:' + i, rows, {W: palette.white}));
P.SHIELD_FRAMES.forEach((rows, i) => bitmap('shield:' + i, rows, {W: palette.white}));
P.EXPLOSION_FRAMES.forEach((rows, i) => bitmap('explosion:' + i, rows, P.BURST_COLORS));
P.IMPACT_FRAMES.forEach((rows, i) => bitmap('impact:' + i, rows, P.BURST_COLORS, 16, 16));
for (const [kind, rows] of Object.entries(P.POWER_UP_BITMAPS)) bitmap('item:' + kind, rows, P.ITEM_COLORS);
for (const direction of directions) bitmap('bullet:' + direction, P.BULLET_FRAMES[direction], {S: palette.light});
P.SCORE_ENEMIES.forEach((rows, i) => bitmap('score:' + i, rows, {W: palette.white, S: palette.light, C: palette.enemyDark}));
bitmap('enemy-icon', P.ENEMY_ICON, P.HUD_COLORS);
for (let p = 0; p < 2; p++) {
  bitmap('life:' + p, P.LIFE_ICON, P.LIFE_COLORS);
  bitmap('hud-player:' + p, P.HUD_PLAYERS[p], P.HUD_COLORS);
}
bitmap('flag', P.FLAG, P.FLAG_COLORS);
bitmap('namcot', P.NAMCOT, {'1': palette.red}); bitmap('credits', CREDITS, {Y: palette.playerGreen, D: palette.playerGreenDark, H: 0xb8f8b8});
for (const [char, rows] of Object.entries(P.FONT)) bitmap('glyph:' + char, rows, {'1': 0xffffff});
bitmap('white', ['1'], {'1': 0xffffff});
bitmap('arrow', P.ARROW, {'1': 0xffffff}); bitmap('arrow-right', P.ARROW_RIGHT, {'1': 0xffffff});
bitmap('pause', P.PAUSE, {R: palette.red});
frame('loss', 32, 16, g => {P.drawText(g, 'GAME', 0, 0, palette.red); P.drawText(g, 'OVER', 0, 8, palette.red);});
for (const [value, rows] of Object.entries(P.POINT_BITMAPS)) bitmap('points:' + value, rows, {W: palette.white});
for (const word of ['BATTLE', 'CITY', 'GAME', 'OVER']) frame('word:' + word, word.length * 32, 32, g => P.drawBrickWord(g, word, 0, 0, word === 'CITY', 4,
  word === 'GAME' || word === 'OVER' ? P.GAMEOVER_BRICKS : undefined));
for (let phase = 0; phase < 4; phase++) for (const char of 'HISCORE0123456789') frame(`hiscore:${phase}:${char}`, 32, 32, g => P.drawBrickWord(g, char, 0, 0, false, 4, P.HISCORE_PALETTES[phase]));
const crc = bytes => {let c = -1; for (const b of bytes) {c ^= b; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);} return (c ^ -1) >>> 0;};
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function png(f) {
  const header = Buffer.alloc(13); header.writeUInt32BE(f.width); header.writeUInt32BE(f.height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((f.width * 4 + 1) * f.height);
  for (let y = 0; y < f.height; y++) f.pixels.copy(rows, y * (f.width * 4 + 1) + 1, y * f.width * 4, (y + 1) * f.width * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function image(width, height) {return {width, height, pixels: Buffer.alloc(width * height * 4)};}
function blit(target, source, left, top) {
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const i = (y * source.width + x) * 4, xx = left + x, yy = top + y;
    if (source.pixels[i + 3] && xx >= 0 && yy >= 0 && xx < target.width && yy < target.height) source.pixels.copy(target.pixels, (yy * target.width + xx) * 4, i, i + 4);
  }
}
const atlas = image(512, 512), regions = []; let left = 1, top = 1, rowHeight = 0;
for (const f of frames.values()) {
  if (left + f.width + 1 > atlas.width) {left = 1; top += rowHeight + 2; rowHeight = 0;}
  if (top + f.height + 1 > atlas.height) throw Error('Atlas overflow');
  blit(atlas, f, left, top); regions.push([f.name, left, top, f.width, f.height].join('\t'));
  left += f.width + 2; rowHeight = Math.max(rowHeight, f.height);
}
save('assets/battle/atlas.png', png(atlas)); save('assets/battle/atlas.txt', regions.join('\n') + '\n');
const enemyKind = kind => {const i = kinds.indexOf(kind); if (i < 0) throw Error('Unknown enemy ' + kind); return i;};
for (let stage = 1; stage <= 35; stage++) {
  const level = getLevel(stage);
  if (level.tiles.length !== 676 || level.enemies.length !== 20) throw Error('Invalid Web level ' + stage);
  save('assets/battle/stage' + stage + '.txt', level.tiles.join(',') + '\n' + level.enemies.map(enemyKind).join(',') + '\n');
}
if (DEMO_ROWS.length !== 26 || DEMO_ROWS.some(row => row.length !== 26)) throw Error('Invalid demo terrain');
const terrain = {'.': 0, B: 1, S: 2, F: 4};
const demo = DEMO_ROWS.flatMap(row => [...row].map(c => {if (terrain[c] === undefined) throw Error('Invalid demo cell'); return terrain[c];}));
const masks = demo.map(tile => tile === 1 ? 15 : 0);
for (const [key, x, y] of [['word:BATTLE', 24, 72], ['word:CITY', 64, 124]]) {
  const f = frames.get(key);
  for (let yy = 0; yy < f.height; yy += 4) for (let xx = 0; xx < f.width; xx += 4) {
    const cx = x + xx - 16, cy = y + yy - 16, cell = (cy >> 3) * 26 + (cx >> 3);
    if (demo[cell] > 1) continue;
    const bit = 1 << ((cy & 4 ? 2 : 0) + (cx & 4 ? 1 : 0));
    if (f.pixels[(yy * f.width + xx) * 4 + 3]) masks[cell] |= bit; else masks[cell] &= ~bit;
    demo[cell] = masks[cell] ? 1 : 0;
  }
}
save('assets/battle/demo.txt', demo.join(',') + '\n' + getLevel(35).enemies.map(enemyKind).join(',') + '\n' + masks.join(',') + '\n');
if (A.AUDIO_TRACKS.length !== 28) throw Error('Invalid Web audio slots');
save('java/org/jiangc/bc/audio/AudioCues.java', `package org.jiangc.bc.audio;\n\n/** Generated from shared audio data. */\nfinal class AudioCues {\n    static final int[] NOTES = {${A.NOTE_PERIODS}};\n    static final int[][] TRACKS = {\n${A.AUDIO_TRACKS.map(track => track === null ? '        null' : '        {' + track.join(',') + '}').join(',\n')}\n    };\n    private AudioCues() {}\n}\n`);
const tank = frames.get('player:0:0:up:0'), paths = new Map();
for (let y = 0; y < 16; y++) for (let x = 0; x < 16;) {
  const rgba = tank.pixels.readUInt32BE((y * 16 + x) * 4), start = x++;
  while (x < 16 && tank.pixels.readUInt32BE((y * 16 + x) * 4) === rgba) x++;
  if (!(rgba & 255)) continue;
  const rgb = (rgba >>> 8).toString(16).padStart(6, '0');
  paths.set(rgb, (paths.get(rgb) || '') + `M${30 + start * 3},${30 + y * 3}h${(x - start) * 3}v3h${-(x - start) * 3}z `);
}
save('res/drawable/ic_launcher_foreground.xml', `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from the shared player bitmap. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n${[...paths].map(([color, path]) => `    <path android:fillColor="#${color}" android:pathData="${path.trim()}" />`).join('\n')}\n</vector>\n`);
save('res/mipmap-anydpi/ic_launcher.xml', readFileSync(new URL('./templates/ic_launcher.xml', import.meta.url)));
const banner = image(320, 180); for (let i = 3; i < banner.pixels.length; i += 4) banner.pixels[i] = 255;
blit(banner, frames.get('word:BATTLE'), 64, 54); blit(banner, frames.get('word:CITY'), 96, 94);
save('res/drawable-xhdpi/tv_banner.png', png(banner));
console.log(`Verified shared Android data: ${frames.size} frames, 35 maps + demo, 28 audio slots.`);
