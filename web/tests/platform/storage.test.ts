import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('powered-on high score', () => {
  it('ignores legacy persistent scores and maps without modifying the record', async () => {
    const getItem = vi.fn(() => JSON.stringify({ highScore: 999999, map: Array(676).fill(2) }));
    const setItem = vi.fn(), removeItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem });
    const { storage } = await import('../../src/platform/storage');
    expect(storage.getHighScore()).toBe(20000);
    expect(storage.highScore(45000)).toBe(45000);
    expect(storage.highScore(20000)).toBe(45000);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
  it('retains the record through a run and resets when the app reloads', async () => {
    const { storage } = await import('../../src/platform/storage');
    storage.highScore(35000);
    expect(storage.getHighScore()).toBe(35000);
    vi.resetModules();
    expect((await import('../../src/platform/storage')).storage.getHighScore()).toBe(20000);
  });
  it('remains playable without storage and rejects invalid scores', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('disabled'); } });
    const { storage } = await import('../../src/platform/storage');
    for (const score of [NaN, Infinity, -100]) expect(storage.highScore(score)).toBe(20000);
    expect(storage.highScore(30000)).toBe(30000);
  });
});
