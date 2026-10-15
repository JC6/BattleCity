import { ENEMY_KINDS, ENEMY_SCORE } from '../core/rules';
import { TICK_MS } from '../core/constants';
import type { GameState } from '../core/types';

// Zero-kill scene timings measured from the cached candidate video's 60 fps
// frames: 35-frame lead, 30 frames per row, 7 extra frames before TOTAL, then
// a 135-frame TOTAL hold. The result-screen instruction chain waits nine
// simulation frames between nonzero counts. These map onto the game's
// 60.0988 Hz ticks; the zero-kill scene
// differs from the 60 fps video's duration by <1 video frame. Renderer and
// sound share this clock, including pauses.
export const SCORE_TIMING = {
  leadMs: 35 * TICK_MS, countMs: 9 * TICK_MS, rowHoldMs: 30 * TICK_MS,
  totalLeadMs: 7 * TICK_MS, totalHoldMs: 135 * TICK_MS,
} as const;
type ScoreState = Pick<GameState, 'players'>;
export interface ScoreRow { counts: (number | null)[]; points: (number | null)[] }
export interface ScoreTimeline {
  rows: ScoreRow[];
  totalVisible: boolean;
  totals: number[];
  cueCount: number;
  completionMs: number;
}

export function scoreTimeline(state: ScoreState, elapsedMs: number): ScoreTimeline {
  // Multiplication and addition of 1000/60 can differ by a few ulps. This
  // sub-microsecond tolerance keeps frame boundaries on their intended tick.
  const elapsed = Math.max(0, elapsedMs) + 1e-7;
  let start = SCORE_TIMING.leadMs;
  let cueCount = 0;
  const rows = ENEMY_KINDS.map((kind, index) => {
    const targets = state.players.map(player => Math.max(0, player.kills[index] ?? 0));
    const maximum = Math.max(0, ...targets);
    const visible = elapsed >= start;
    const count = visible ? Math.min(maximum, Math.floor((elapsed - start) / SCORE_TIMING.countMs)) : 0;
    cueCount += count;
    const counts = targets.map(target => visible ? Math.min(target, count) : null);
    start += maximum * SCORE_TIMING.countMs + SCORE_TIMING.rowHoldMs;
    return { counts, points: counts.map(value => value === null ? null : value * ENEMY_SCORE[kind]) };
  });
  start += SCORE_TIMING.totalLeadMs;
  return {
    rows, cueCount, totalVisible: elapsed >= start,
    totals: state.players.map(player => player.kills.reduce((sum, value) => sum + value, 0)),
    completionMs: start + SCORE_TIMING.totalHoldMs,
  };
}

/** Includes the final TOTAL hold, so automatic advance cannot truncate counts. */
export function scoreCompletionMs(state: ScoreState): number { return scoreTimeline(state, 0).completionMs; }
