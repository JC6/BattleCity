import { decodeTerrainCode } from '../data/levels';
import { BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE } from './constants';
import { VECTORS } from './geometry';
import { FORTRESS_CELLS } from './rules';
import { Tile, type Direction } from './types';

export const CONSTRUCTION_SIZE = GRID_SIZE / 2;
export const CONSTRUCTION_CODE_COUNT = 14;
const BASE_BLOCK = BASE_Y / TILE_SIZE / 2 * CONSTRUCTION_SIZE + BASE_X / TILE_SIZE / 2;

/** One volatile Construction map, independent of the game's destructible terrain. */
export class ConstructionState {
  private readonly terrain = Array<Tile>(GRID_SIZE * GRID_SIZE);
  private readonly paintedCodes = new Int8Array(CONSTRUCTION_SIZE * CONSTRUCTION_SIZE);
  private eagleVisible = true;
  private position = { x: 0, y: 0 };
  private actedSinceMovement = false;
  selectedCode = 0;

  constructor() { this.reset(); }

  get cursor(): Readonly<{ x: number; y: number }> { return { ...this.position }; }

  /** The editor's initial eagle disappears when its block or any glyph cell is overwritten. */
  get baseVisible(): boolean { return this.eagleVisible; }

  get tiles(): Tile[] { return [...this.terrain]; }

  /** Accept an 8px fixture edit; valid same-value writes are accepted too. */
  setTile(index: number, tile: Tile): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= GRID_SIZE * GRID_SIZE ||
      !Number.isInteger(tile) || tile < Tile.Empty || tile > Tile.Ice) return false;
    const block = Math.floor(index / GRID_SIZE / 2) * CONSTRUCTION_SIZE + Math.floor(index % GRID_SIZE / 2);
    this.terrain[index] = tile;
    // Even a same-value edit must be consumed by the next block paint.
    this.paintedCodes[block] = -1;
    if (block === BASE_BLOCK) this.eagleVisible = false;
    return true;
  }

  reset(): void {
    this.terrain.fill(Tile.Empty);
    for (const index of FORTRESS_CELLS) this.terrain[index] = Tile.Brick;
    this.paintedCodes.fill(-1);
    this.eagleVisible = true;
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
    if (this.paintedCodes[index] === this.selectedCode) return false;
    decodeTerrainCode(this.selectedCode).forEach((tile, quadrant) => {
      this.terrain[cell + (quadrant >> 1) * GRID_SIZE + (quadrant & 1)] = tile;
    });
    this.paintedCodes[index] = this.selectedCode;
    if (index === BASE_BLOCK) this.eagleVisible = false;
    return true;
  }
}
