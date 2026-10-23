import { describe, expect, it } from 'vitest';
import { ConstructionState } from '../../src/core/construction';
import { FORTRESS_CELLS } from '../../src/core/rules';
import { Tile } from '../../src/core/types';

const B = Tile.Brick, S = Tile.Steel, E = Tile.Empty;
const initialTiles = Array.from({ length: 26 * 26 }, (_, index) => FORTRESS_CELLS.includes(index) ? B : E);
const cells = (state: ConstructionState, x: number, y: number) => {
  const tiles = state.tiles;
  return [tiles[y * 2 * 26 + x * 2], tiles[y * 2 * 26 + x * 2 + 1],
    tiles[(y * 2 + 1) * 26 + x * 2], tiles[(y * 2 + 1) * 26 + x * 2 + 1]];
};
const editable = () => {
  const state = new ConstructionState();
  state.move('right'); state.move('down');
  state.selectedCode = 4;
  return state;
};

describe('volatile keyboard Construction model', () => {
  it('begins with empty terrain around the existing eight-cell fortress', () => {
    const state = new ConstructionState();
    expect(state.tiles).toEqual(initialTiles);
    expect(state.cursor).toEqual({ x: 0, y: 0 });
    expect(state.selectedCode).toBe(0);
    expect(state.baseVisible).toBe(true);
  });

  it.each([
    [0, [E, B, E, B]], [1, [E, E, B, B]], [2, [B, E, B, E]], [3, [B, B, E, E]], [4, [B, B, B, B]],
    [5, [E, S, E, S]], [6, [E, E, S, S]], [7, [S, E, S, E]], [8, [S, S, E, E]], [9, [S, S, S, S]],
    [10, Array(4).fill(Tile.Water)], [11, Array(4).fill(Tile.Forest)],
    [12, Array(4).fill(Tile.Ice)], [13, [E, E, E, E]],
  ] as const)('decodes code %i into its literal half-wall or terrain geometry', (code, expected) => {
    const state = editable();
    while (state.selectedCode !== code) state.cycle(1);
    state.paint();
    expect(cells(state, 1, 1)).toEqual(expected);
  });

  it('cycles in either direction, wraps and paints immediately at the cursor', () => {
    const state = editable();
    state.selectedCode = 13;
    state.cycle(1);
    expect(state.selectedCode).toBe(0);
    expect(cells(state, 1, 1)).toEqual([E, B, E, B]);
    state.cycle(-1);
    expect(state.selectedCode).toBe(13);
    expect(cells(state, 1, 1)).toEqual([E, E, E, E]);
  });

  it('keeps ordinary moves neutral and supports placing a selected block after held-button moves', () => {
    const state = editable();
    state.cycle(1); // Right half of steel.
    state.move('right');
    expect(cells(state, 2, 1)).toEqual([E, E, E, E]);
    expect(state.paint()).toBe(true);
    expect(cells(state, 2, 1)).toEqual([E, S, E, S]);
    expect(state.paint()).toBe(false);
    state.move('down'); state.paint();
    expect(cells(state, 2, 2)).toEqual([E, S, E, S]);
    expect(cells(state, 1, 1)).toEqual([E, S, E, S]);
  });

  it('keeps an injected single cell when keyboard cycling paints a different block', () => {
    const state = editable();
    expect(state.setTile(270, S)).toBe(true);
    expect(state.setTile(270, S)).toBe(true);
    expect(cells(state, 5, 5)).toEqual([S, E, E, E]);
    state.cycle(1);
    expect(cells(state, 1, 1)).toEqual([E, S, E, S]);
    expect(cells(state, 5, 5)).toEqual([S, E, E, E]);
  });

  it('repaints a patched block even with the same selected code and preserves outside patches', () => {
    const state = editable();
    state.paint();
    expect(state.paint()).toBe(false);
    state.setTile(54, Tile.Forest);
    state.setTile(55, S);
    state.setTile(80, E);
    state.setTile(81, Tile.Ice);
    state.setTile(270, Tile.Water);
    expect(cells(state, 1, 1)).toEqual([Tile.Forest, S, E, Tile.Ice]);
    const before = state.tiles;
    expect(state.paint()).toBe(true);
    expect(cells(state, 1, 1)).toEqual([B, B, B, B]);
    expect(state.tiles.flatMap((tile, index) => tile === before[index] ? [] : [index])).toEqual([54, 55, 80, 81]);
    expect(state.tiles[270]).toBe(Tile.Water);
    expect(state.paint()).toBe(false);
    state.selectedCode = 13;
    state.paint();
    expect(cells(state, 1, 1)).toEqual([E, E, E, E]);
    expect(state.tiles[270]).toBe(Tile.Water);
  });

  it('consumes a same-value single-cell edit on the next paint only', () => {
    const state = editable();
    state.paint();
    const before = state.tiles;
    expect(state.setTile(54, before[54])).toBe(true);
    expect(state.tiles).toEqual(before);
    expect(state.paint()).toBe(true);
    expect(state.paint()).toBe(false);
    expect(state.tiles).toEqual(before);
  });

  it.each([636, 637, 662, 663])('hides the eagle after an empty write to base cell %i until reset', index => {
    const state = new ConstructionState();
    const before = state.tiles;
    expect(before[index]).toBe(E);
    expect(state.setTile(index, E)).toBe(true);
    expect(state.tiles).toEqual(before);
    expect(state.baseVisible).toBe(false);
    state.enter();
    expect(state.baseVisible).toBe(false);
    state.reset();
    expect(state.baseVisible).toBe(true);
    for (let step = 0; step < 6; step++) state.move('right');
    for (let step = 0; step < 12; step++) state.move('down');
    state.selectedCode = 13;
    expect(state.paint()).toBe(true);
    expect(state.tiles).toEqual(before);
    expect(state.baseVisible).toBe(false);
    expect(state.paint()).toBe(false);
  });

  it('applies single-cell patches after the initial fortress and replaces only the painted base block', () => {
    const state = new ConstructionState();
    for (let step = 0; step < 5; step++) state.move('right');
    for (let step = 0; step < 11; step++) state.move('down');
    expect(state.setTile(23 * 26 + 11, S)).toBe(true);
    expect(state.setTile(23 * 26 + 12, Tile.Forest)).toBe(true);
    expect(cells(state, 5, 11)).toEqual([E, E, E, S]);
    state.selectedCode = 13;
    expect(state.paint()).toBe(true);
    expect(cells(state, 5, 11)).toEqual([E, E, E, E]);
    expect(state.tiles[23 * 26 + 12]).toBe(Tile.Forest);
    expect(state.tiles[23 * 26 + 13]).toBe(B);
    expect(state.paint()).toBe(false);
  });

  it('rejects malformed single-cell edits without changing the model', () => {
    const state = editable();
    state.setTile(270, S);
    const before = state.tiles;
    for (const index of [-1, 676, 1.5, NaN, Infinity]) expect(state.setTile(index, S)).toBe(false);
    for (const tile of [-1, 6, 0.5, NaN, Infinity]) expect(state.setTile(54, tile)).toBe(false);
    expect(state.tiles).toEqual(before);
    expect(state.cursor).toEqual({ x: 1, y: 1 });
    expect(state.selectedCode).toBe(4);
  });

  it('isolates patched snapshots and clears both patches and keyboard edits on reset', () => {
    const state = editable();
    state.cycle(1);
    state.setTile(270, Tile.Ice);
    state.setTile(23 * 26 + 12, E);
    const snapshot = state.tiles;
    snapshot.fill(S);
    expect(cells(state, 1, 1)).toEqual([E, S, E, S]);
    expect(state.tiles[270]).toBe(Tile.Ice);
    expect(state.tiles[23 * 26 + 12]).toBe(E);
    state.reset();
    expect(state.tiles).toEqual(initialTiles);
    expect(state.cursor).toEqual({ x: 0, y: 0 });
    expect(state.selectedCode).toBe(0);
    expect(snapshot.every(tile => tile === S)).toBe(true);
  });

  it('allows painting every macro-block, including player/enemy entries and the eagle', () => {
    for (const [x, y] of [[0, 0], [6, 0], [12, 0], [4, 12], [6, 12], [8, 12]]) {
      const state = new ConstructionState();
      for (let step = 0; step < x!; step++) state.move('right');
      for (let step = 0; step < y!; step++) state.move('down');
      expect(state.press(1)).toBe(true);
      expect(state.selectedCode).toBe(0);
      expect(cells(state, x!, y!)).toEqual([E, B, E, B]);
      expect(state.baseVisible).toBe(!(x === 6 && y === 12));
    }
    const state = new ConstructionState();
    for (let step = 0; step < 5; step++) state.move('right');
    for (let step = 0; step < 11; step++) state.move('down');
    expect(cells(state, 5, 11)).toEqual([E, E, E, B]);
    state.selectedCode = 13;
    state.paint();
    expect(cells(state, 5, 11)).toEqual([E, E, E, E]);
    expect(state.tiles[23 * 26 + 12]).toBe(B);
  });

  it.each([1, -1] as const)('places code zero on the first %i press, then cycles and wraps until a direction is held', direction => {
    const state = new ConstructionState();
    expect(state.press(direction)).toBe(true);
    expect(state.selectedCode).toBe(0);
    expect(cells(state, 0, 0)).toEqual([E, B, E, B]);
    expect(state.press(direction)).toBe(true);
    expect(state.selectedCode).toBe(direction === 1 ? 1 : 13);
    state.directionHeld(); // Includes held frames between accepted repeats.
    expect(state.press(-direction as 1 | -1)).toBe(false);
    expect(state.selectedCode).toBe(direction === 1 ? 1 : 13);
    state.press(-direction as 1 | -1);
    expect(state.selectedCode).toBe(0);
  });

  it('clears the first-action flag even for an outward direction and leaves held painting neutral', () => {
    const state = new ConstructionState();
    state.press(1); state.press(1);
    expect(state.selectedCode).toBe(1);
    expect(state.move('left')).toBe(false);
    expect(state.press(1)).toBe(false);
    expect(state.selectedCode).toBe(1);
    state.move('right');
    state.paint(); // Held A/B placement must not arm the cycle flag.
    expect(state.press(-1)).toBe(false);
    expect(state.selectedCode).toBe(1);
    state.press(-1);
    expect(state.selectedCode).toBe(0);
  });

  it('accepts single-cell edits in former protected areas and resets eagle and first-action state', () => {
    const state = new ConstructionState();
    expect(state.setTile(0, S)).toBe(true);
    expect(state.setTile(24 * 26 + 8, Tile.Water)).toBe(true);
    expect(state.setTile(24 * 26 + 12, Tile.Forest)).toBe(true);
    expect(state.tiles[0]).toBe(S);
    expect(state.tiles[24 * 26 + 8]).toBe(Tile.Water);
    expect(state.baseVisible).toBe(false);
    state.press(1); state.press(1);
    state.reset();
    expect(state.baseVisible).toBe(true);
    expect(state.tiles).toEqual(initialTiles);
    state.press(-1);
    expect(state.selectedCode).toBe(0);
  });

  it('reenters with fresh controls while retaining painted blocks, fortress edits and single-cell patches', () => {
    const state = editable();
    state.press(1); state.press(1);
    state.setTile(270, Tile.Forest);
    state.setTile(23 * 26 + 11, E);
    state.setTile(24 * 26 + 12, S);
    const draft = state.tiles;
    expect(state.selectedCode).toBe(5);
    expect(state.baseVisible).toBe(false);
    state.enter();
    expect(state.tiles).toEqual(draft);
    expect(state.baseVisible).toBe(false);
    expect(state.cursor).toEqual({ x: 0, y: 0 });
    expect(state.selectedCode).toBe(0);
    state.press(-1);
    expect(state.selectedCode).toBe(0); // First B places code zero instead of cycling backward to 13.
    expect(cells(state, 0, 0)).toEqual([E, B, E, B]);
    expect(cells(state, 1, 1)).toEqual([E, S, E, S]);
    expect(state.tiles[270]).toBe(Tile.Forest);
    expect(state.tiles[23 * 26 + 11]).toBe(E);
    expect(state.tiles[24 * 26 + 12]).toBe(S);
  });

  it('clamps cursor movement and isolates cursor snapshots', () => {
    const state = editable();
    const cursor = state.cursor as { x: number; y: number };
    cursor.x = 99;
    expect(state.cursor).toEqual({ x: 1, y: 1 });
    for (let step = 0; step < 20; step++) { state.move('right'); state.move('down'); }
    expect(state.cursor).toEqual({ x: 12, y: 12 });
    expect(state.move('right')).toBe(false);
    expect(state.move('down')).toBe(false);
  });
});
