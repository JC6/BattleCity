import type { GameEvent, GameMode, GameState, PlayerInput, Tile } from '../core/types';
import type { LogicalPad } from '../platform/input';

export type ArenaPresentation =
  | { kind: 'menu'; selection: 0 | 1 | 2; highScore: number; playerScores: number[] }
  | { kind: 'intro'; stage: number; elapsedMs: number; paused?: boolean }
  | { kind: 'stage-select'; stage: number; mode?: GameMode }
  | { kind: 'game'; paused?: boolean }
  | { kind: 'score'; state: GameState; highScore: number; elapsedMs: number; bonusPlayer?: 0 | 1 | null }
  | { kind: 'gameover'; highScore?: number }
  | { kind: 'hiscore'; highScore: number; tick: number }
  | { kind: 'editor'; cursor?: { x: number; y: number }; baseVisible?: boolean };

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
  draft: readonly Tile[] | null;
  presentation: ArenaPresentation;
}
export interface AppPorts {
  input: AppInput;
  audio: AppAudio;
  render: AppRenderer;
  seed(): number;
  records: { getHighScore(): number; highScore(score: number): number };
}
