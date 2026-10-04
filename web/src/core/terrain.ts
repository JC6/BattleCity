import { ARENA_SIZE, BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE } from './constants';
import { overlapArea, overlaps, tankRect, type Rect } from './geometry';
import { FORTRESS_CELLS } from './rules';
import { Tile, type GameState, type Tank } from './types';

export const BASE_RECT: Rect = { x: BASE_X, y: BASE_Y, width: 16, height: 16 };

export function forEachTile(rect: Rect, visit: (index: number, x: number, y: number) => void): void {
  const left = Math.max(0, Math.floor(rect.x / TILE_SIZE));
  const right = Math.min(GRID_SIZE - 1, Math.floor((rect.x + rect.width - 0.001) / TILE_SIZE));
  const top = Math.max(0, Math.floor(rect.y / TILE_SIZE));
  const bottom = Math.min(GRID_SIZE - 1, Math.floor((rect.y + rect.height - 0.001) / TILE_SIZE));
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      visit(row * GRID_SIZE + column, column * TILE_SIZE, row * TILE_SIZE);
    }
  }
}

// Four 4px quadrants in each 8px brick cell: TL=1, TR=2, BL=4, BR=8.
export function brickIntersects(mask: number, x: number, y: number, rect: Rect): boolean {
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    if ((mask & (1 << quadrant)) && overlaps(rect, {
      x: x + (quadrant & 1) * 4, y: y + (quadrant >> 1) * 4, width: 4, height: 4,
    })) return true;
  }
  return false;
}

function terrainBlocks(state: GameState, rect: Rect): boolean {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > ARENA_SIZE ||
      rect.y + rect.height > ARENA_SIZE || overlaps(rect, BASE_RECT)) return true;
  let blocked = false;
  forEachTile(rect, (index, x, y) => {
    const tile = state.tiles[index];
    if (tile === Tile.Steel || tile === Tile.Water ||
        (tile === Tile.Brick && brickIntersects(state.brickMasks[index]!, x, y, rect))) blocked = true;
  });
  return blocked;
}

export function canOccupy(state: GameState, tank: Tank, x: number, y: number): boolean {
  const rect = tankRect({ x, y });
  if (terrainBlocks(state, rect)) return false;
  return !state.tanks.some(other => {
    if (other.id === tank.id) return false;
    const otherRect = tankRect(other);
    const nextOverlap = overlapArea(rect, otherRect);
    if (nextOverlap === 0) return false;
    // The original can spawn directly on an occupied entry. Such existing
    // overlap must be escapable, without allowing movement into new tanks.
    return nextOverlap >= overlapArea(tankRect(tank), otherRect);
  });
}

export function onIce(state: GameState, tank: Tank): boolean {
  const column = Math.floor((tank.x + 8) / TILE_SIZE);
  const row = Math.floor((tank.y + 8) / TILE_SIZE);
  return state.tiles[row * GRID_SIZE + column] === Tile.Ice;
}

export function setFortress(state: GameState, tile: Tile.Brick | Tile.Steel): void {
  for (const index of FORTRESS_CELLS) {
    state.tiles[index] = tile;
    state.brickMasks[index] = tile === Tile.Brick ? 15 : 0;
  }
}
