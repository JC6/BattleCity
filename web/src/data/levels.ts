import { GRID_SIZE, normalizeStage } from '../core/constants';
import { ENEMY_KINDS, FORTRESS_CELLS } from '../core/rules';
import { Tile, type LevelDefinition } from '../core/types';
import { ORIGINAL_ENEMIES, ORIGINAL_MAPS } from './original';

// Wall masks use top-left, top-right, bottom-left, bottom-right bit order.
const WALL_MASKS = [0b1010, 0b1100, 0b0101, 0b0011, 0b1111];

export function expandOriginalMap(map: readonly (readonly number[])[]): Tile[] {
  if (map.length !== 13 || map.some((row) => row.length !== 13)) {
    throw new Error('An original stage must contain 13 × 13 blocks.');
  }
  const tiles: Tile[] = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => Tile.Empty);
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const nibble = map[row]![col]!;
      if (!Number.isInteger(nibble) || nibble < 0 || nibble > 15) {
        throw new Error(`Invalid terrain nibble ${nibble}.`);
      }
      const wall = nibble < 10;
      const mask = wall ? WALL_MASKS[nibble % 5]! : 0b1111;
      const terrain = nibble < 5 ? Tile.Brick : nibble < 10 ? Tile.Steel
        : nibble === 10 ? Tile.Water : nibble === 11 ? Tile.Forest
          : nibble === 12 ? Tile.Ice : Tile.Empty;
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        if ((mask & (1 << quadrant)) === 0) continue;
        const x = col * 2 + (quadrant % 2);
        const y = row * 2 + Math.floor(quadrant / 2);
        tiles[y * GRID_SIZE + x] = terrain;
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

export const LEVELS: readonly LevelDefinition[] = ORIGINAL_MAPS.map((map, index) => ({
  tiles: expandOriginalMap(map),
  enemies: ORIGINAL_ENEMIES[index]!.map((kind) => ENEMY_KINDS[kind]!),
}));

/** Stage numbers are one based; each play session receives independent terrain and queue. */
export function getLevel(stage: number): LevelDefinition {
  const normalized = normalizeStage(stage);
  const level = LEVELS[(normalized - 1) % LEVELS.length]!;
  // Round two repeats the maps with stage 35's enemy composition. After
  // stage 70 the original resets both its stage counter and difficulty.
  const enemyLevel = LEVELS[Math.min(normalized, LEVELS.length) - 1]!;
  return { tiles: [...level.tiles], enemies: [...enemyLevel.enemies] };
}
