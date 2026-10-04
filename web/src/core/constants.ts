const TICK_RATE = 60.0988;
export const TICK_MS = 1000 / TICK_RATE;
export const GRID_SIZE = 26;
export const TILE_SIZE = 8;
export const ARENA_SIZE = GRID_SIZE * TILE_SIZE;
export const TANK_SIZE = 16;
export const BASE_X = 96;
export const BASE_Y = 192;

/** The Famicom game plays two 35-map rounds, then returns to stage one. */
export function normalizeStage(stage: number): number {
  if (!Number.isInteger(stage) || stage < 1) {
    throw new RangeError('Stage must be a positive integer.');
  }
  return ((stage - 1) % 70) + 1;
}
