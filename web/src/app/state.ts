import type { GameEngine } from '../core/engine';
import type { LossPresentationWorld } from '../core/loss-presentation';

interface TimedState { engine: GameEngine; duration: number; ticks: number }
export type TimedAppState =
  | (TimedState & { kind: 'loss'; world: LossPresentationWorld })
  | (TimedState & { kind: 'score' | 'gameover' | 'hiscore' });
/** Each battle/presentation owns its required engine; menus cannot retain one. */
export type AppState =
  | { kind: 'menu' | 'editor' | 'stage-select' }
  | { kind: 'game'; engine: GameEngine }
  | TimedAppState;
export function isTimedState(state: AppState): state is TimedAppState { return 'duration' in state; }
