import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { TICK_MS } from '../../src/core/constants';
import { scoreCompletionMs, scoreTimeline } from '../../src/game/score-timeline';

describe('shared result presentation timeline', () => {
  it('counts a row gradually, delays later rows, and preserves the authoritative result', () => {
    const state = new GameEngine(getLevel(1), { mode: 'single', stage: 1, seed: 1 }).state;
    state.players[0].kills = [2, 1, 0, 0]; state.players[0].score = 12345;
    const original = structuredClone(state);
    const firstRow = 35 * TICK_MS;
    const secondRow = 83 * TICK_MS;
    expect(scoreTimeline(state, firstRow - 1).rows[0].counts).toEqual([null]);
    expect(scoreTimeline(state, firstRow).rows[0].counts).toEqual([0]);
    expect(scoreTimeline(state, firstRow + 8 * TICK_MS).rows[0].counts).toEqual([0]);
    expect(scoreTimeline(state, firstRow + 9 * TICK_MS).rows[0]).toEqual({ counts: [1], points: [100] });
    expect(scoreTimeline(state, firstRow + 18 * TICK_MS).rows[0]).toEqual({ counts: [2], points: [200] });
    expect(scoreTimeline(state, secondRow - 1).rows[1].counts).toEqual([null]);
    expect(scoreTimeline(state, secondRow).rows[1].counts).toEqual([0]);
    expect(scoreTimeline(state, secondRow + 9 * TICK_MS).rows[1].points).toEqual([200]);
    const totalAt = scoreCompletionMs(state) - 135 * TICK_MS;
    expect(scoreTimeline(state, totalAt - 1).totalVisible).toBe(false);
    expect(scoreTimeline(state, totalAt).totalVisible).toBe(true);
    expect(scoreTimeline(state, totalAt).totals).toEqual([3]);
    expect(scoreTimeline(state, totalAt).cueCount).toBe(3);
    expect(state).toEqual(original);
  });
  it('counts cooperative players on the same row clock, including empty rows', () => {
    const state = new GameEngine(getLevel(1), { mode: 'coop', stage: 1, seed: 1 }).state;
    state.players[0].kills = [1, 0, 0, 0]; state.players[1].kills = [3, 0, 0, 0];
    expect(scoreTimeline(state, 44 * TICK_MS).rows[0].counts).toEqual([1, 1]);
    expect(scoreTimeline(state, 62 * TICK_MS).rows[0].counts).toEqual([1, 3]);
    expect(scoreTimeline(state, 62 * TICK_MS).cueCount).toBe(3); // One sound per shared count tick.
    expect(scoreTimeline(state, 92 * TICK_MS).rows[1].counts).toEqual([0, 0]);
    expect(scoreTimeline(state, scoreCompletionMs(state)).totals).toEqual([1, 3]);
  });
  it('keeps the candidate zero-kill scene blank, reveals four rows, then holds TOTAL', () => {
    const state = new GameEngine(getLevel(1), { mode: 'single', stage: 1, seed: 1 }).state;
    expect(scoreTimeline(state, 34 * TICK_MS).rows.every(row => row.counts[0] === null)).toBe(true);
    for (const [index, tick] of [35, 65, 95, 125].entries()) {
      const rows = scoreTimeline(state, tick * TICK_MS).rows;
      expect(rows.map(row => row.counts[0])).toEqual(Array.from({ length: 4 }, (_, row) => row <= index ? 0 : null));
    }
    expect(scoreTimeline(state, 161 * TICK_MS).totalVisible).toBe(false);
    expect(scoreTimeline(state, 162 * TICK_MS).totalVisible).toBe(true);
    expect(scoreTimeline(state, 296 * TICK_MS).totalVisible).toBe(true);
    expect(scoreTimeline(state, 296 * TICK_MS).cueCount).toBe(0);
    expect(scoreCompletionMs(state)).toBeCloseTo(297 * TICK_MS, 8);
    expect(Math.abs(scoreCompletionMs(state) - 4950)).toBeLessThan(1000 / 60);
  });
});
