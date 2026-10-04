import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRID_SIZE, normalizeStage } from '../../src/core/constants';
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
