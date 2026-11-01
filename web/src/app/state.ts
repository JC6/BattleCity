import type { GameEngine } from '../core/engine';

interface TimedState { engine: GameEngine; duration: number; ticks: number }
type TimedAppState =
  | (TimedState & { kind: 'score'; bonusChecked: boolean; bonusPlayer: 0 | 1 | null })
  | (TimedState & { kind: 'gameover' | 'hiscore' });
/** Each battle/presentation owns its required engine; menus cannot retain one. */
export type AppState =
  | { kind: 'menu' | 'editor' | 'stage-select' }
  | { kind: 'game'; engine: GameEngine }
  | TimedAppState;
export function isTimedState(state: AppState): state is TimedAppState { return 'duration' in state; }
