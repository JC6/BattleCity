import { ENEMY_KINDS, ENEMY_SCORE } from '../core/rules';
import { TICK_MS } from '../core/constants';
import type { GameState } from '../core/types';

// CCD4–CEE7: 30 lead ticks, row setup, 9 per count including its final
// zero iteration, 20 between rows, 30 before TOTAL, 15 before BONUS, 120 hold.
export const SCORE_TIMING = { leadMs: 31 * TICK_MS, countMs: 9 * TICK_MS, totalHoldMs: 135 * TICK_MS } as const;
type ScoreState = Pick<GameState, 'players'>;
interface ScoreRow { counts: (number | null)[]; points: (number | null)[] }
interface ScoreTimeline {
  rows: ScoreRow[];
  totalVisible: boolean;
  totals: number[];
  cueCount: number;
  completionMs: number;
  bonusAtMs: number;
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
    const count = visible ? Math.min(maximum, 1 + Math.floor((elapsed - start) / SCORE_TIMING.countMs)) : 0;
    cueCount += count;
    const counts = targets.map(target => visible ? Math.min(target, count) : null);
    start += (9 * (maximum + 1) + (index < 3 ? 21 : 30)) * TICK_MS;
    return { counts, points: counts.map(value => value === null ? null : value * ENEMY_SCORE[kind]) };
  });
  return {
    rows, cueCount, totalVisible: elapsed >= start,
    totals: state.players.map(player => player.kills.reduce((sum, value) => sum + value, 0)),
    completionMs: start + SCORE_TIMING.totalHoldMs, bonusAtMs: start + 15 * TICK_MS,
  };
}

/** Includes the final TOTAL hold, so automatic advance cannot truncate counts. */
export function scoreCompletionMs(state: ScoreState): number { return scoreTimeline(state, 0).completionMs; }
