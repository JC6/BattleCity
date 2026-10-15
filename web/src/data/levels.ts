import { GRID_SIZE, normalizeStage } from '../core/constants';
import { ENEMY_KINDS, FORTRESS_CELLS } from '../core/rules';
import { Tile, type LevelDefinition } from '../core/types';
import { ORIGINAL_ENEMIES, ORIGINAL_MAPS } from './original';

// Wall masks use top-left, top-right, bottom-left, bottom-right bit order.
const WALL_MASKS = [0b1010, 0b1100, 0b0101, 0b0011, 0b1111];

/** Decode one 16px terrain block into TL, TR, BL, BR 8px cells. */
export function decodeTerrainCode(code: number): [Tile, Tile, Tile, Tile] {
  if (!Number.isInteger(code) || code < 0 || code > 15) {
    throw new Error(`Invalid terrain nibble ${code}.`);
  }
  const mask = code < 10 ? WALL_MASKS[code % 5]! : 0b1111;
  const terrain = code < 5 ? Tile.Brick : code < 10 ? Tile.Steel
    : code === 10 ? Tile.Water : code === 11 ? Tile.Forest
      : code === 12 ? Tile.Ice : Tile.Empty;
  return [0, 1, 2, 3].map(quadrant => mask & (1 << quadrant) ? terrain : Tile.Empty) as [Tile, Tile, Tile, Tile];
}

export function expandOriginalMap(map: readonly (readonly number[])[]): Tile[] {
  if (map.length !== 13 || map.some((row) => row.length !== 13)) {
    throw new Error('An original stage must contain 13 × 13 blocks.');
  }
  const tiles: Tile[] = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => Tile.Empty);
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const cells = decodeTerrainCode(map[row]![col]!);
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const x = col * 2 + (quadrant % 2);
        const y = row * 2 + Math.floor(quadrant / 2);
        tiles[y * GRID_SIZE + x] = cells[quadrant]!;
      }
    }
  }
  // The original installs the fortress separately from stage terrain.
  for (const index of FORTRESS_CELLS) tiles[index] = Tile.Brick;
  for (const [x, y] of [[12, 24], [13, 24], [12, 25], [13, 25]]) {
    tiles[y! * GRID_SIZE + x!] = Tile.Empty;
  }
  return tiles;
}

// The recorded original clears these cells around its separately installed base.
// Stage 10: source 644.0s; stage 21: source 1332.5s (implementation baseline review).
// Keep the raw maps and generic decoder intact; apply only observed standard-stage cells.
const BASE_CLEARANCE: Readonly<Partial<Record<number, readonly (readonly [number, number])[]>>> = {
  10: [[10, 23], [15, 23], [10, 24], [15, 24], [10, 25], [15, 25]],
  21: [[10, 22], [11, 22], [12, 22], [13, 22], [14, 22], [15, 22], [10, 23], [15, 23]],
};

export const LEVELS: readonly LevelDefinition[] = ORIGINAL_MAPS.map((map, index) => {
  const tiles = expandOriginalMap(map);
  for (const [x, y] of BASE_CLEARANCE[index + 1] ?? []) tiles[y * GRID_SIZE + x] = Tile.Empty;
  return {
    tiles,
    enemies: ORIGINAL_ENEMIES[index]!.map((kind) => ENEMY_KINDS[kind]!),
  };
});

/** Stage numbers are one based; each play session receives independent terrain and queue. */
export function getLevel(stage: number): LevelDefinition {
  const normalized = normalizeStage(stage);
  const level = LEVELS[(normalized - 1) % LEVELS.length]!;
  // Round two repeats the maps with stage 35's enemy composition. After
  // stage 70 the original resets both its stage counter and difficulty.
  const enemyLevel = LEVELS[Math.min(normalized, LEVELS.length) - 1]!;
  return { tiles: [...level.tiles], enemies: [...enemyLevel.enemies] };
}
