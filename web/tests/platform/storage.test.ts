import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Tile } from '../../src/core/types';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('browser preferences', () => {
  it('keeps a playable session when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage disabled'); },
      setItem: () => { throw new Error('Storage disabled'); },
    });
    const { storage } = await import('../../src/platform/storage');
    storage.highScore(30000);
    storage.volume(0.6);
    expect(storage.get().highScore).toBe(30000);
    expect(storage.get().volume).toBe(0.6);
  });

  it('preserves the newest session values when writes fail against stale storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ highScore: 20000, volume: 0.3 }),
      setItem: () => { throw new Error('Quota exceeded'); },
    });
    const { storage } = await import('../../src/platform/storage');
    storage.highScore(40000);
    storage.volume(0.8);
    expect(storage.get().highScore).toBe(40000);
    expect(storage.get().volume).toBe(0.8);
  });

  it('rejects malformed settings and clones custom maps', async () => {
    let raw = '{broken';
    vi.stubGlobal('localStorage', {
      getItem: () => raw,
      setItem: (_key: string, value: string) => { raw = value; },
    });
    const { storage } = await import('../../src/platform/storage');
    expect(storage.get().highScore).toBe(20000);
    const map = Array.from({ length: 676 }, () => Tile.Empty);
    storage.map(map);
    map[100] = Tile.Steel;
    const snapshot = storage.get();
    expect(snapshot.map?.[100]).toBe(Tile.Empty);
    snapshot.map![100] = Tile.Water;
    expect(storage.get().map?.[100]).toBe(Tile.Empty);
    expect(JSON.parse(raw).map[100]).toBe(Tile.Empty);
    vi.resetModules();
    const reloaded = (await import('../../src/platform/storage')).storage;
    expect(reloaded.get().map?.[100]).toBe(Tile.Empty);
  });

  it('loads lazily and reads high scores from memory without cloning a map', async () => {
    const getItem = vi.fn(() => JSON.stringify({ highScore: 34500, volume: 0.3, map: Array(676).fill(0) }));
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    const { storage } = await import('../../src/platform/storage');
    expect(getItem).not.toHaveBeenCalled();
    for (let index = 0; index < 100; index++) expect(storage.getHighScore()).toBe(34500);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('does not read or write again for unchanged preferences', async () => {
    const map = Array<Tile>(676).fill(Tile.Empty);
    const getItem = vi.fn(() => JSON.stringify({ highScore: 20000, volume: 0.3, map }));
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    const { storage } = await import('../../src/platform/storage');
    storage.get();
    storage.volume(0.3);
    storage.highScore(10000);
    storage.map([...map]);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('merges a newer cross-tab high score and other preferences before a setting write', async () => {
    let raw = JSON.stringify({ highScore: 20000, volume: 0.3 });
    const setItem = vi.fn((_key: string, value: string) => { raw = value; });
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem });
    const { storage } = await import('../../src/platform/storage');
    expect(storage.getHighScore()).toBe(20000);
    const map = Array<Tile>(676).fill(Tile.Forest);
    const delayed = JSON.stringify({ highScore: 50000, volume: 0.8, map });
    raw = delayed;
    // The other tab's storage event has not reached this tab yet.
    storage.volume(0);
    expect(JSON.parse(raw)).toEqual({ highScore: 50000, volume: 0, map });
    const localMap = Array<Tile>(676).fill(Tile.Steel);
    storage.map(localMap);
    expect(storage.handleStorageEvent({ key: 'battlecity.web.v1', newValue: delayed } as StorageEvent)).toBe(false);
    const expected = { highScore: 50000, volume: 0, map: localMap };
    expect(storage.get()).toEqual(expected);
    expect(JSON.parse(raw)).toEqual(expected);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite an already higher score when a storage event is pending', async () => {
    let raw = JSON.stringify({ highScore: 20000, volume: 0.3 });
    const setItem = vi.fn((_key: string, value: string) => { raw = value; });
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem });
    const { storage } = await import('../../src/platform/storage');
    storage.getHighScore();
    raw = JSON.stringify({ highScore: 50000, volume: 0.3 });
    expect(storage.highScore(40000)).toBe(50000);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('syncs cross-tab settings while high scores never decrease', async () => {
    let raw: string | null = null;
    const setItem = vi.fn((_key: string, value: string) => { raw = value; });
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem });
    const { storage } = await import('../../src/platform/storage');
    storage.highScore(45000);
    const map = Array<Tile>(676).fill(Tile.Water);
    const event = (value: object, key = 'battlecity.web.v1') => ({ key, newValue: JSON.stringify(value) }) as StorageEvent;
    raw = JSON.stringify({ highScore: 50000, volume: 0.8, map });
    expect(storage.handleStorageEvent(event({ highScore: 50000, volume: 0.8, map }))).toBe(true);
    expect(storage.get()).toEqual({ highScore: 50000, volume: 0.8, map });
    raw = JSON.stringify({ highScore: 100, volume: 0.8, map });
    expect(storage.handleStorageEvent(event({ highScore: 100, volume: 0.8, map }))).toBe(false);
    expect(storage.getHighScore()).toBe(50000);
    const latestMap = Array<Tile>(676).fill(Tile.Forest);
    raw = JSON.stringify({ highScore: 60000, volume: 0.6, map: latestMap });
    expect(storage.handleStorageEvent(event({ highScore: 55000, volume: 0, map }))).toBe(true);
    expect(storage.get()).toEqual({ highScore: 60000, volume: 0.6, map: latestMap });
    expect(storage.handleStorageEvent(event({ highScore: 90000 }, 'another-app'))).toBe(false);
    expect(storage.handleStorageEvent({ key: 'battlecity.web.v1', newValue: '{broken' } as StorageEvent)).toBe(false);
    const copy = storage.get();
    copy.map![0] = Tile.Steel;
    expect(storage.get().map![0]).toBe(Tile.Forest);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'malformed', 'unavailable'] as const)('retains session preferences when the latest record is %s', async condition => {
    const map = Array<Tile>(676).fill(Tile.Steel);
    const getItem = vi.fn().mockReturnValueOnce(JSON.stringify({ highScore: 45000, volume: 0.6, map }));
    if (condition === 'unavailable') getItem.mockImplementation(() => { throw new Error('Access revoked'); });
    else getItem.mockReturnValue(condition === 'missing' ? null : '{broken');
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    const { storage } = await import('../../src/platform/storage');
    expect(storage.getHighScore()).toBe(45000);
    const incoming = JSON.stringify({ highScore: 50000, volume: 0, map: Array(676).fill(Tile.Water) });
    expect(storage.handleStorageEvent({ key: 'battlecity.web.v1', newValue: incoming } as StorageEvent)).toBe(true);
    expect(storage.get()).toEqual({ highScore: 50000, volume: 0.6, map });
    expect(setItem).not.toHaveBeenCalled();
  });

  it('retains session changes when a later read fails before saving', async () => {
    const getItem = vi.fn().mockReturnValueOnce(JSON.stringify({ highScore: 30000, volume: 0.3 }))
      .mockImplementation(() => { throw new Error('Access revoked'); });
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    const { storage } = await import('../../src/platform/storage');
    expect(storage.getHighScore()).toBe(30000);
    expect(storage.highScore(40000)).toBe(40000);
    storage.volume(0.6);
    expect(storage.get().volume).toBe(0.6);
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).toHaveBeenCalledTimes(2);
  });
});
