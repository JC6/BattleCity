import type Phaser from 'phaser';
import { Tile, type Direction, type EnemyKind, type Tank } from '../core/types';
import { BRICK_TILES, BULLET, DESTROYED_BASE, EAGLE, ENEMY_ICON, EXPLOSION_FRAMES,
  FLAG, FONT, FOREST, ICE, IMPACT_FRAMES, LIFE_ICON, PALETTE, POWER_UP_BITMAPS,
  SHIELD, SPAWN_FRAMES, STEEL, TERRAIN_COLORS, WATER, directionalBitmap, drawBitmap,
  drawText, tankBitmap, tankColors, type Bitmap, type PixelSurface } from './pixel-assets';
import { ImagePixels, NativeTexture } from './textures';

export const ATLAS_SIZE = 512;
interface FrameRecipe {
  name: string; width: number; height: number;
  paint(surface: PixelSurface): void;
}
export interface AtlasFrame { x: number; y: number; width: number; height: number }
const directions: readonly Direction[] = ['up', 'right', 'down', 'left'];
const kinds: readonly EnemyKind[] = ['basic', 'fast', 'power', 'armor'];

export function tankFrame(tank: Tank, tread: 0 | 1, tick: number): string {
  if (tank.team === 'player') return `player:${tank.playerIndex}:${Math.max(0, Math.min(3, tank.stars))}:${tank.direction}:${tread}`;
  const palette = tank.carryingPowerUp && tick % 20 < 10 ? 'flash' :
    tank.kind === 'armor' ? `hp${Math.max(1, Math.min(4, tank.hp))}` : 'normal';
  return `enemy:${tank.kind}:${palette}:${tank.direction}:${tread}`;
}

export function tileFrame(tile: Tile, mask: number, waterPhase: number): string | null {
  switch (tile) {
    case Tile.Brick: return `brick:${mask & 15}`;
    case Tile.Steel: return 'steel';
    case Tile.Water: return `water:${waterPhase}`;
    case Tile.Forest: return 'forest';
    case Tile.Ice: return 'ice';
    default: return null;
  }
}

/** Enumerate only used silhouettes/palettes, rather than their Cartesian product. */
export function atlasRecipes(): FrameRecipe[] {
  const recipes: FrameRecipe[] = [];
  const bitmap = (name: string, rows: Bitmap, colors: Readonly<Record<string, number>>, opaque = false) => {
    const width = rows[0]?.length ?? 0, height = rows.length;
    recipes.push({ name, width, height, paint(surface) {
      if (opaque) { surface.fillStyle(PALETTE.black); surface.fillRect(0, 0, width, height); }
      drawBitmap(surface, rows, 0, 0, colors);
    } });
  };
  BRICK_TILES.forEach((rows, mask) => bitmap(`brick:${mask}`, rows, { M: PALETTE.light, D: PALETTE.brickDark, B: PALETTE.brick }));
  bitmap('steel', STEEL, { L: PALETTE.light, D: PALETTE.gray, W: PALETTE.white });
  WATER.forEach((rows, phase) => bitmap(`water:${phase}`, rows, TERRAIN_COLORS.water));
  bitmap('forest', FOREST, TERRAIN_COLORS.forest, true);
  bitmap('ice', ICE, TERRAIN_COLORS.ice);
  bitmap('base:alive', EAGLE, { S: PALETTE.gray, R: PALETTE.brickDark }, true);
  bitmap('base:dead', DESTROYED_BASE, { S: PALETTE.gray, R: PALETTE.brickDark }, true);
  const tank: Tank = { id: 0, team: 'player', playerIndex: 0, enemySlot: null, kind: 'basic', x: 0, y: 0,
    direction: 'up', hp: 1, stars: 0, shieldTicks: 0, spawnTicks: 0, stunTicks: 0,
    aiTicks: 0, slideTicks: 0, moving: false, carryingPowerUp: false };
  for (const playerIndex of [0, 1] as const) for (let stars = 0; stars < 4; stars++) {
    for (const direction of directions) for (const tread of [0, 1] as const) {
      Object.assign(tank, { team: 'player', playerIndex, stars, direction });
      bitmap(tankFrame(tank, tread, 10), tankBitmap(tank, tread), tankColors(tank, 10));
    }
  }
  for (const kind of kinds) for (let palette = 0; palette < (kind === 'armor' ? 5 : 2); palette++) {
    for (const direction of directions) for (const tread of [0, 1] as const) {
      Object.assign(tank, { team: 'enemy', playerIndex: null, kind, hp: kind === 'armor' ? Math.max(1, palette) : 1,
        carryingPowerUp: palette === 0, direction });
      bitmap(tankFrame(tank, tread, 0), tankBitmap(tank, tread), tankColors(tank, 0));
    }
  }
  SPAWN_FRAMES.forEach((rows, phase) => bitmap(`spawn:${phase}`, rows, { Y: PALETTE.yellow, W: 0xf8d878 }));
  bitmap('shield', SHIELD, { W: PALETTE.white });
  for (const direction of directions) bitmap(`bullet:${direction}`, directionalBitmap(BULLET, direction), { W: PALETTE.white, D: PALETTE.light });
  IMPACT_FRAMES.forEach((rows, phase) => bitmap(`impact:${phase}`, rows, { W: PALETTE.white, Y: PALETTE.yellow }));
  EXPLOSION_FRAMES.forEach((rows, phase) => bitmap(`explosion:${phase}`, rows, { W: PALETTE.white, Y: PALETTE.yellow, R: PALETTE.red }));
  for (const [kind, rows] of Object.entries(POWER_UP_BITMAPS)) bitmap(`item:${kind}`, rows, { W: PALETTE.white }, true);
  for (const [char, rows] of Object.entries(FONT)) bitmap(`glyph:${char}`, rows, { '1': PALETTE.white });
  bitmap('enemy-icon', ENEMY_ICON, { B: PALETTE.black, R: PALETTE.brickDark });
  bitmap('life:0', LIFE_ICON, { Y: PALETTE.brick }); bitmap('life:1', LIFE_ICON, { Y: PALETTE.green });
  bitmap('flag', FLAG, { B: PALETTE.black, R: PALETTE.brick });
  bitmap('gray', ['1'], { '1': PALETTE.gray });
  recipes.push({ name: 'pause', width: 56, height: 16, paint(surface) {
    surface.fillStyle(PALETTE.black); surface.fillRect(0, 0, 56, 16); drawText(surface, 'PAUSE', 8, 4);
  } });
  recipes.push({ name: 'loss', width: 32, height: 16, paint(surface) {
    drawText(surface, 'GAME', 0, 0, PALETTE.red); drawText(surface, 'OVER', 0, 8, PALETTE.red);
  } });
  return recipes;
}

export class NativeAtlas extends NativeTexture {
  readonly frames = new Map<string, AtlasFrame>();
  constructor(scene: Phaser.Scene, key: string) {
    super(scene, key, ATLAS_SIZE, ATLAS_SIZE);
    const image = this.texture.context.createImageData(ATLAS_SIZE, ATLAS_SIZE);
    const pixels = new ImagePixels(image);
    let x = 1, y = 1, rowHeight = 0;
    for (const recipe of atlasRecipes()) {
      if (x + recipe.width + 1 > ATLAS_SIZE) { x = 1; y += rowHeight + 2; rowHeight = 0; }
      if (y + recipe.height + 1 > ATLAS_SIZE || this.frames.has(recipe.name)) throw new Error(`Invalid native atlas frame: ${recipe.name}`);
      pixels.place(x, y, recipe.width, recipe.height);
      recipe.paint(pixels);
      this.texture.add(recipe.name, 0, x, y, recipe.width, recipe.height);
      this.frames.set(recipe.name, { x, y, width: recipe.width, height: recipe.height });
      x += recipe.width + 2; rowHeight = Math.max(rowHeight, recipe.height);
    }
    this.texture.context.putImageData(image, 0, 0);
    this.refresh();
  }
  draw(target: NativeTexture, name: string, x: number, y: number): void {
    const frame = this.frames.get(name);
    if (!frame) throw new Error(`Missing native atlas frame: ${name}`);
    target.texture.context.drawImage(this.texture.canvas, frame.x, frame.y, frame.width, frame.height,
      x, y, frame.width, frame.height);
  }
}
