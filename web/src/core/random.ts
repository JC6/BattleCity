import type { GameState } from './types';

// Browser scheduling and Math.random never enter the simulation. The seed
// lives in GameState so a captured state exposes the random stream position.
export function randomInt(state: GameState, limit: number): number {
  let value = state.rng || 0x6d2b79f5;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.rng = value >>> 0;
  return state.rng % limit;
}
