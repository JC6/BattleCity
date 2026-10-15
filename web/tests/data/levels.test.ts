import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRID_SIZE, normalizeStage } from '../../src/core/constants';
import { GameEngine } from '../../src/core/engine';
import { FORTRESS_CELLS } from '../../src/core/rules';
import { Tile } from '../../src/core/types';
import { expandOriginalMap, getLevel, LEVELS } from '../../src/data/levels';
import { ORIGINAL_ENEMIES, ORIGINAL_MAPS } from '../../src/data/original';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('Famicom stage dataset', () => {
  it('preserves all 35 maps and enemy queues', () => {
    // Fixed checksums cover every terrain cell and each enemy's position in the queue.
    expect(digest(ORIGINAL_MAPS)).toBe('7434d38acb5bb2a0aee119c2f62d02be4dfe2592193b7db8e5829312aafced32');
    expect(digest(ORIGINAL_ENEMIES)).toBe('55ec289190484e2b4b76ad0d9dec972d5d274689f8edab63365e4e03f4a66233');
  });

  it('contains complete playable stages with 20 enemies each', () => {
    expect(LEVELS).toHaveLength(35);
    for (const level of LEVELS) {
      expect(level.tiles).toHaveLength(GRID_SIZE * GRID_SIZE);
      expect(level.tiles.every(tile => Number.isInteger(tile) && tile >= Tile.Empty && tile <= Tile.Ice)).toBe(true);
      expect(level.enemies).toHaveLength(20);
      expect(level.enemies.every(kind => ['basic', 'fast', 'power', 'armor'].includes(kind))).toBe(true);
    }
  });

  it('preserves half walls when converting 16px blocks to 8px terrain', () => {
    const map = Array.from({ length: 13 }, () => Array.from({ length: 13 }, () => 13));
    map[0][0] = 0; // Right half of a brick block.
    map[0][1] = 5; // Right half of a steel block.
    const tiles = expandOriginalMap(map);
    expect([tiles[0], tiles[1], tiles[26], tiles[27]]).toEqual([Tile.Empty, Tile.Brick, Tile.Empty, Tile.Brick]);
    expect([tiles[2], tiles[3], tiles[28], tiles[29]]).toEqual([Tile.Empty, Tile.Steel, Tile.Empty, Tile.Steel]);
  });

  it.each([10, 21, 45, 56])('matches the observed base surroundings in stage %i', stage => {
    const tiles = getLevel(stage).tiles;
    // Literal 6 × 4 region, from the source 644.0s and 1332.5s opening PNGs.
    // B is the original eight-cell fortress; base footprint itself is stored as empty.
    const expected = [
      [Tile.Empty, Tile.Empty, Tile.Empty, Tile.Empty, Tile.Empty, Tile.Empty],
      [Tile.Empty, Tile.Brick, Tile.Brick, Tile.Brick, Tile.Brick, Tile.Empty],
      [Tile.Empty, Tile.Brick, Tile.Empty, Tile.Empty, Tile.Brick, Tile.Empty],
      [Tile.Empty, Tile.Brick, Tile.Empty, Tile.Empty, Tile.Brick, Tile.Empty],
    ];
    expect(Array.from({ length: 4 }, (_, row) => tiles.slice((row + 22) * 26 + 10, (row + 22) * 26 + 16))).toEqual(expected);
  });

  it('preserves neighboring terrain outside the observed stage 21 clearance', () => {
    const tiles = getLevel(21).tiles;
    expect(tiles[22 * 26 + 9]).toBe(Tile.Steel);
    expect(tiles[22 * 26 + 16]).toBe(Tile.Brick);
    expect(tiles[21 * 26 + 12]).toBe(Tile.Brick);
    expect(tiles[21 * 26 + 13]).toBe(Tile.Brick);
  });

  it('changes exactly the 14 observed cells and leaves every other decoded map cell intact', () => {
    const corrected: Record<number, number[]> = {
      10: [23 * 26 + 10, 23 * 26 + 15, 24 * 26 + 10, 24 * 26 + 15, 25 * 26 + 10, 25 * 26 + 15],
      21: [22 * 26 + 10, 22 * 26 + 11, 22 * 26 + 12, 22 * 26 + 13, 22 * 26 + 14, 22 * 26 + 15, 23 * 26 + 10, 23 * 26 + 15],
    };
    for (let stage = 1; stage <= 35; stage++) {
      const raw = expandOriginalMap(ORIGINAL_MAPS[stage - 1]!);
      const final = getLevel(stage).tiles;
      const changed = final.flatMap((tile, i) => tile === raw[i] ? [] : [i]);
      expect(changed, `stage ${stage}`).toEqual(corrected[stage] ?? []);
      for (const i of changed) expect([raw[i], final[i]]).toEqual([Tile.Brick, Tile.Empty]);
    }
    expect(getLevel(45).enemies).toEqual(getLevel(35).enemies);
    expect(getLevel(56).enemies).toEqual(getLevel(35).enemies);
  });

  it.each(['single', 'coop'] as const)('initializes corrected terrain and brick masks in %s mode', mode => {
    const engine = new GameEngine(getLevel(21), { mode, stage: 21 });
    for (const i of [22 * 26 + 10, 22 * 26 + 11, 22 * 26 + 12, 22 * 26 + 13, 22 * 26 + 14, 22 * 26 + 15, 23 * 26 + 10, 23 * 26 + 15]) {
      expect([engine.state.tiles[i], engine.state.brickMasks[i]]).toEqual([Tile.Empty, 0]);
    }
    for (const i of FORTRESS_CELLS) expect([engine.state.tiles[i], engine.state.brickMasks[i]]).toEqual([Tile.Brick, 15]);
    expect(engine.state.baseAlive).toBe(true);
  });

  it('preserves custom terrain in the same cells without mutating the supplied draft', () => {
    const custom = getLevel(21);
    const painted = [22 * 26 + 10, 22 * 26 + 12, 23 * 26 + 15, 25 * 26 + 10];
    for (const i of painted) custom.tiles[i] = Tile.Brick;
    const before = [...custom.tiles];
    const engine = new GameEngine(custom, { mode: 'coop', stage: 21 });
    for (const i of painted) expect([engine.state.tiles[i], engine.state.brickMasks[i]]).toEqual([Tile.Brick, 15]);
    expect(custom.tiles).toEqual(before);
    expect(getLevel(21).tiles[22 * 26 + 12]).toBe(Tile.Empty);
  });

  it('repeats maps with stage 35 enemies during the second round only', () => {
    expect(getLevel(36).tiles).toEqual(getLevel(1).tiles);
    expect(getLevel(36).enemies).toEqual(getLevel(35).enemies);
    expect(getLevel(70).tiles).toEqual(getLevel(35).tiles);
    expect(getLevel(70).enemies).toEqual(getLevel(35).enemies);
  });

  it('restarts the original map and enemy rounds after each 70 stages', () => {
    expect(getLevel(71).tiles).toEqual(getLevel(1).tiles);
    expect(getLevel(71).enemies).toEqual(getLevel(1).enemies);
    expect(getLevel(140).tiles).toEqual(getLevel(35).tiles);
    expect(getLevel(140).enemies).toEqual(getLevel(35).enemies);
    expect(getLevel(141).tiles).toEqual(getLevel(1).tiles);
    expect(getLevel(141).enemies).toEqual(getLevel(1).enemies);
  });

  it.each([[1, 1], [35, 35], [36, 36], [70, 70], [71, 1],
    [105, 35], [106, 36], [140, 70], [141, 1]])('normalizes stage %i to %i', (input, expected) => {
    expect(normalizeStage(input)).toBe(expected);
  });

  it('returns independent definitions so gameplay cannot corrupt the source', () => {
    const first = getLevel(1);
    const expected = getLevel(1);
    first.tiles.fill(Tile.Empty);
    first.enemies.length = 0;
    expect(getLevel(1)).toEqual(expected);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid stage %s', stage => {
    expect(() => getLevel(stage)).toThrow(RangeError);
    expect(() => normalizeStage(stage)).toThrow(RangeError);
  });

  it('rejects malformed stage maps', () => {
    expect(() => expandOriginalMap([])).toThrow();
    const map = Array.from({ length: 13 }, () => Array.from({ length: 13 }, () => 13));
    map[0][0] = 16;
    expect(() => expandOriginalMap(map)).toThrow();
  });
});
