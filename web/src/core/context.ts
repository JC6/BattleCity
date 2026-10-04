import type { GameEvent, GameState } from './types';

export interface CoreContext {
  state: GameState;
  events: GameEvent[];
  /** Unique tank/bullet identity only; gameplay cadence uses fixed enemy slots. */
  nextId(): number;
}
