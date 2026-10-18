import type { GameEvent, GameState, PlayerInput, Tile } from '../core/types';
import type { LogicalPad } from '../platform/input';
import type { ArenaPresentation } from './presentation';

export interface AppInput {
  read(): PlayerInput[];
  readPads(): LogicalPad[];
  clear(): void;
  resetForFocus(): void;
}
export interface AppAudio {
  stopScene(): void;
  setPaused(paused: boolean, reason?: 'manual' | 'focus'): void;
  syncState(state: GameState | null): void;
  play(events: readonly GameEvent[]): void;
  commitFrame(): void;
  updateScore(state: GameState, elapsedMs: number): void;
  startPresentation(kind: 'gameover' | 'hiscore'): void;
}
/** Borrowed views: the controller owns mutations, the renderer only reads. */
export interface AppRenderer {
  state: Readonly<GameState> | null;
  hudState: Readonly<GameState> | null;
  draft: readonly Tile[] | null;
  presentation: ArenaPresentation;
  resetAnimation(): void;
  observeStep(state: Readonly<GameState>): void;
}
export interface AppPorts {
  input: AppInput;
  audio: AppAudio;
  render: AppRenderer;
  seed(): number;
  records: { getHighScore(): number; highScore(score: number): number };
}
