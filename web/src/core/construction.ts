import { decodeTerrainCode } from '../data/levels';
import { BASE_X, BASE_Y, GRID_SIZE } from './constants';
import { VECTORS } from './geometry';
import { FORTRESS_CELLS } from './rules';
import { Tile, type Direction } from './types';

export const CONSTRUCTION_SIZE = GRID_SIZE / 2;
export const CONSTRUCTION_CODE_COUNT = 14;

/** One volatile Construction map, independent of the game's destructible terrain. */
export class ConstructionState {
  private codes = Array<number>(CONSTRUCTION_SIZE * CONSTRUCTION_SIZE).fill(13);
  private painted = Array<boolean>(CONSTRUCTION_SIZE * CONSTRUCTION_SIZE).fill(false);
  private readonly tilePatches = new Map<number, Tile>();
  private position = { x: 0, y: 0 };
  private actedSinceMovement = false;
  selectedCode = 0;

  get cursor(): Readonly<{ x: number; y: number }> { return { ...this.position }; }

  /** The editor's initial eagle disappears when its block or any glyph cell is overwritten. */
  get baseVisible(): boolean {
    const block = (BASE_Y / 16) * CONSTRUCTION_SIZE + BASE_X / 16;
    const cell = (BASE_Y / 8) * GRID_SIZE + BASE_X / 8;
    return !this.painted[block] &&
      ![cell, cell + 1, cell + GRID_SIZE, cell + GRID_SIZE + 1].some(index => this.tilePatches.has(index));
  }

  get tiles(): Tile[] {
    const tiles = Array<Tile>(GRID_SIZE * GRID_SIZE).fill(Tile.Empty);
    this.codes.forEach((code, index) => {
      const x = (index % CONSTRUCTION_SIZE) * 2;
      const y = Math.floor(index / CONSTRUCTION_SIZE) * 2;
      decodeTerrainCode(code).forEach((tile, quadrant) => {
        tiles[(y + (quadrant >> 1)) * GRID_SIZE + x + (quadrant & 1)] = tile;
      });
    });
    // Initial base bricks occupy single 8px cells that a half-wall block code
    // cannot represent. Painting a macro-block can replace them as before.
    for (const index of FORTRESS_CELLS) {
      const block = Math.floor(Math.floor(index / GRID_SIZE) / 2) * CONSTRUCTION_SIZE +
        Math.floor((index % GRID_SIZE) / 2);
      if (!this.painted[block]) tiles[index] = Tile.Brick;
    }
    for (const [index, tile] of this.tilePatches) tiles[index] = tile;
    return tiles;
  }

  /** Accept an 8px fixture edit; valid same-value writes are accepted too. */
  setTile(index: number, tile: Tile): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= GRID_SIZE * GRID_SIZE ||
      !Number.isInteger(tile) || tile < Tile.Empty || tile > Tile.Ice) return false;
    this.tilePatches.set(index, tile);
    return true;
  }

  reset(): void {
    this.codes.fill(13);
    this.painted.fill(false);
    this.tilePatches.clear();
    this.enter();
  }

  /** C0BE resets the editor controls on every entry, while its map remains in memory. */
  enter(): void {
    this.position = { x: 0, y: 0 };
    this.actedSinceMovement = false;
    this.selectedCode = 0;
  }

  move(direction: Direction): boolean {
    this.directionHeld();
    const [dx, dy] = VECTORS[direction];
    const x = this.position.x + dx, y = this.position.y + dy;
    if (x < 0 || y < 0 || x >= CONSTRUCTION_SIZE || y >= CONSTRUCTION_SIZE) return false;
    this.position = { x, y };
    return true;
  }

  /** C6D2 clears the first-action flag on every held-direction frame, including at an edge. */
  directionHeld(): void {
    this.actedSinceMovement = false;
  }

  /** First A/B press places the current code; later presses cycle until a direction is held. */
  press(direction: 1 | -1): boolean {
    if (this.actedSinceMovement) return this.cycle(direction);
    this.actedSinceMovement = true;
    return this.paint();
  }

  cycle(direction: 1 | -1): boolean {
    this.selectedCode = (this.selectedCode + direction + CONSTRUCTION_CODE_COUNT) % CONSTRUCTION_CODE_COUNT;
    return this.paint();
  }

  /** Call after moving while A or B remains held to place the selected block. */
  paint(): boolean {
    const { x, y } = this.position;
    const index = y * CONSTRUCTION_SIZE + x;
    const cell = y * 2 * GRID_SIZE + x * 2;
    let patched = false;
    for (const tileIndex of [cell, cell + 1, cell + GRID_SIZE, cell + GRID_SIZE + 1]) {
      if (this.tilePatches.delete(tileIndex)) patched = true;
    }
    if (!patched && this.painted[index] && this.codes[index] === this.selectedCode) return false;
    this.codes[index] = this.selectedCode;
    this.painted[index] = true;
    return true;
  }
}
