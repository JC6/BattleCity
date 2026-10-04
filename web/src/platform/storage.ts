import type { Tile } from '../core/types';

interface Preferences { highScore: number; volume: number; map?: Tile[] }
const KEY = 'battlecity.web.v1';
let cached: Preferences = { highScore: 20000, volume: 0.3 };
let initialized = false;
let persistentStorage = true;

function readPersistent(): string | null {
  if (!persistentStorage) return null;
  try { return localStorage.getItem(KEY); } catch { persistentStorage = false; return null; }
}

function decode(raw: string | null): Preferences | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Partial<Preferences>;
    const map = Array.isArray(p.map) && p.map.length === 676 && p.map.every(v => Number.isInteger(v) && v >= 0 && v <= 5)
      ? p.map : cached.map;
    return {
      highScore: typeof p.highScore === 'number' && Number.isFinite(p.highScore) && p.highScore >= 0 ? p.highScore : cached.highScore,
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : cached.volume,
      ...(map ? { map } : {}),
    };
  } catch { return null; } // Invalid JSON can be repaired by the next real save.
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  cached = decode(readPersistent()) ?? cached;
}

function sameMap(a?: Tile[], b?: Tile[]): boolean {
  return a === b || !!a && !!b && a.length === b.length && a.every((tile, index) => tile === b[index]);
}

function equal(a: Preferences, b: Preferences): boolean {
  return a.highScore === b.highScore && a.volume === b.volume && sameMap(a.map, b.map);
}

function save(patch: Partial<Preferences>): void {
  initialize();
  const candidate = { ...cached, ...patch, highScore: Math.max(cached.highScore, patch.highScore ?? 0) };
  if (equal(candidate, cached)) return;
  // A storage event may still be queued, so merge the latest record before writing.
  const latest = decode(readPersistent());
  const next = { ...(latest ?? cached), ...patch, highScore: Math.max(cached.highScore, latest?.highScore ?? 0, patch.highScore ?? 0) };
  cached = next;
  if (!persistentStorage || (latest && equal(next, latest))) return;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { persistentStorage = false; }
}

export const storage = {
  get(): Preferences {
    initialize();
    return { ...cached, ...(cached.map ? { map: [...cached.map] } : {}) };
  },
  getHighScore(): number { initialize(); return cached.highScore; },
  highScore(score: number): number {
    if (Number.isFinite(score) && score >= 0) save({ highScore: score });
    return this.getHighScore();
  },
  volume(volume: number): void {
    if (Number.isFinite(volume)) save({ volume: Math.min(1, Math.max(0, volume)) });
  },
  map(tiles: Tile[]): void { save({ map: [...tiles] }); },
  handleStorageEvent(event: StorageEvent): boolean {
    if (event.key !== KEY) return false;
    initialize();
    const incoming = decode(event.newValue);
    if (!incoming) return false;
    // A queued event can predate a newer local or remote save.
    const latest = decode(readPersistent());
    const highScore = Math.max(cached.highScore, incoming.highScore, latest?.highScore ?? 0);
    const next = { ...(latest ?? cached), highScore };
    if (equal(cached, next)) return false;
    cached = next;
    return true;
  },
};
