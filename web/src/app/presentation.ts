import type { GameMode, GameState } from '../core/types';

export type ArenaPresentation =
  | { kind: 'menu'; selection: 0 | 1 | 2; highScore: number; playerScores: number[] }
  | { kind: 'intro'; stage: number; elapsedMs: number; paused?: boolean }
  | { kind: 'stage-select'; stage: number; mode?: GameMode }
  | { kind: 'game'; lossBannerProgress?: number; paused?: boolean }
  | { kind: 'score'; state: GameState; highScore: number; elapsedMs: number }
  | { kind: 'gameover'; highScore?: number }
  | { kind: 'hiscore'; highScore: number; tick: number }
  | { kind: 'editor'; cursor?: { x: number; y: number }; baseVisible?: boolean };

