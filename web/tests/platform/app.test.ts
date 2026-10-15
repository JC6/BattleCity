import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICK_MS } from '../../src/core/constants';
import { Tile, type GameOptions, type GameState, type LevelDefinition, type PlayerInput } from '../../src/core/types';
import { scoreTimeline } from '../../src/game/score-timeline';

const runtime = vi.hoisted(() => ({
  scene: null as null | { state: GameState | null; onFrame(delta: number): void; scale: { getParentBounds(): void; refresh(): void } },
  parent: null as null | { style: Record<string, string> },
  canvasSize: { width: 0, height: 0 },
  destroyed: 0,
  audioEvents: [] as string[],
  audioSyncStates: [] as (GameState | null)[],
  engines: [] as { state: GameState }[],
  engineOptions: [] as GameOptions[],
  engineFailure: null as Error | null,
}));
vi.mock('../../src/core/engine', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/engine')>('../../src/core/engine');
  return { ...actual, GameEngine: class extends actual.GameEngine {
    constructor(level: LevelDefinition, options: GameOptions) {
      runtime.engineOptions.push(options);
      if (runtime.engineFailure) throw runtime.engineFailure;
      super(level, options);
      runtime.engines.push(this);
    }
  } };
});
vi.mock('phaser', () => ({
  default: {
    Scene: class {
      scale = {
        parentSize: { width: 0, height: 0 },
        getParentBounds() {
          this.parentSize.width = Number.parseInt(runtime.parent!.style.width);
          this.parentSize.height = Number.parseInt(runtime.parent!.style.height);
        },
        refresh() {
          // Phaser renders from cached parent bounds, then measures the parent again.
          Object.assign(runtime.canvasSize, this.parentSize);
          this.getParentBounds();
        },
      };
      constructor(_key: string) {}
    },
    Game: class {
      destroy() { runtime.destroyed++; }
      constructor(config: { scene: typeof runtime.scene[] }) {
        runtime.scene = config.scene[0];
        runtime.scene!.scale.getParentBounds();
        runtime.scene!.scale.refresh();
      }
    },
    AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 },
  },
}));
vi.mock('../../src/platform/audio', () => ({
  GameAudio: class {
    dispose() { runtime.audioEvents.push('dispose'); return Promise.resolve(); }
    unlock() {} stopScene() { runtime.audioEvents.push('stop'); } setPaused(_paused: boolean) {}
    syncState(state: GameState | null) { runtime.audioSyncStates.push(state); }
    advanceTick() { runtime.audioEvents.push('tick'); }
    commitFrame() { runtime.audioEvents.push('commit'); }
    startPresentation(kind: string) { runtime.audioEvents.push(kind); }
    play(_events: unknown) {} updateScore(_state: unknown, _elapsed: number) {}
  },
}));
interface Harness {
  state(): GameState | null;
  presentation(): { kind: string; selection?: number; stage?: number; mode?: string; highScore?: number; playerScores?: number[]; paused?: boolean; elapsedMs?: number };
  step(count?: number, inputs?: PlayerInput[]): void;
  debug(patch: Partial<GameState>): void;
  setEditorTile(index: number, tile: Tile): void;
  getEditorTiles(): Tile[];
  editor(): { cursor: { x: number; y: number }; selectedCode: number };
}
let events: Map<string, ((event: unknown) => void)[]>;
let api: Harness;
let dispose: () => Promise<void>;
let wrapper: { style: Record<string, string> };
function dispatch(type: string, event: unknown = {}): void { events.get(type)?.forEach(handler => handler(event)); }
function down(code: string, repeat = false): void { dispatch('keydown', { code, repeat, preventDefault() {} }); }
function up(code: string): void { dispatch('keyup', { code }); }
function frame(count = 1): void { for (let i = 0; i < count; i++) runtime.scene!.onFrame(TICK_MS + 0.00001); }
function tap(code: string): void { down(code); frame(); up(code); frame(); }
function controlledSeeds(): number[] {
  const seeds: number[] = [];
  vi.stubGlobal('crypto', { getRandomValues(values: Uint32Array) {
    const seed = 0x1234 + seeds.length;
    seeds.push(seed); values[0] = seed; return values;
  } });
  return seeds;
}
function loseFocus(trigger: 'blur' | 'visibilitychange'): void {
  if (trigger === 'visibilitychange') Object.assign(document, { hidden: true });
  dispatch(trigger);
}
function until(kind: string): void {
  for (let i = 0; i < 1000 && api.presentation().kind !== kind; i++) frame();
  expect(api.presentation().kind).toBe(kind);
}
beforeEach(async () => {
  vi.resetModules();
  runtime.audioEvents = []; runtime.destroyed = 0;
  runtime.audioSyncStates = []; runtime.engines = []; runtime.engineOptions = []; runtime.engineFailure = null;
  events = new Map();
  const listen = (type: string, handler: (event: unknown) => void) => events.set(type, [...(events.get(type) ?? []), handler]);
  wrapper = { style: {} };
  runtime.parent = wrapper;
  const app = { innerHTML: '', querySelector: () => wrapper };
  const unlisten = (type: string, handler: (event: unknown) => void) => events.set(type, (events.get(type) ?? []).filter(value => value !== handler));
  const fakeWindow = { innerWidth: 1280, innerHeight: 720, addEventListener: listen, removeEventListener: unlisten };
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', { hidden: false, hasFocus: () => true, addEventListener: listen, removeEventListener: unlisten, querySelector: () => app });
  dispose = (await import('../../src/main')).application.dispose;
  api = (fakeWindow as typeof fakeWindow & { __BATTLECITY__: Harness }).__BATTLECITY__;
// The first import also transforms the application; allow for cold filesystem I/O.
}, 30000);
afterEach(async () => { await dispose(); vi.unstubAllGlobals(); runtime.scene = null; runtime.parent = null; });

describe('keyboard application flow', () => {
  it('disposes listeners, the test bridge, audio and Phaser exactly once', async () => {
    const scene = runtime.scene!;
    const done = dispose(); expect(dispose()).toBe(done); await done;
    expect(runtime.destroyed).toBe(1);
    expect(runtime.audioEvents.filter(event => event === 'dispose')).toHaveLength(1);
    expect([...events.values()].every(handlers => handlers.length === 0)).toBe(true);
    expect('__BATTLECITY__' in window).toBe(false);
    const before = [...runtime.audioEvents]; scene.onFrame(100); down('Enter');
    expect(runtime.audioEvents).toEqual(before);
  });
  it('prepares a stage without installing or advancing it and starts the same tick-zero engine', () => {
    const seeds = controlledSeeds();
    const audioBeforeSelection = [...runtime.audioEvents];
    down('Enter');
    expect(api.presentation()).toMatchObject({ kind: 'stage-select', mode: 'single', stage: 1 });
    expect(runtime.engines).toHaveLength(1);
    const prepared = runtime.engines[0];
    expect(prepared.state).toMatchObject({ tick: 0, phase: 'intro', rng: seeds[0] });
    expect(api.state()).toBeNull(); expect(runtime.scene!.state).toBeNull();
    expect(runtime.audioEvents).toEqual(audioBeforeSelection);
    expect(runtime.audioSyncStates).toEqual([]);
    api.step(12); frame(30);
    expect(runtime.engines).toHaveLength(1); expect(seeds).toHaveLength(1);
    expect(prepared.state.tick).toBe(0);
    expect(api.state()).toBeNull(); expect(runtime.scene!.state).toBeNull();
    expect(runtime.audioSyncStates).toEqual([]);
    up('Enter'); down('Enter');
    expect(runtime.engines).toHaveLength(1); expect(seeds).toHaveLength(1);
    expect(runtime.scene!.state).toBe(prepared.state);
    expect(api.state()).toMatchObject({ tick: 0, phase: 'intro', mode: 'single', stage: 1, rng: seeds[0] });
    expect(runtime.audioSyncStates).toEqual([prepared.state]);
  });

  it('rebuilds only changed cooperative selections and consumes the final selected stage', () => {
    const seeds = controlledSeeds();
    tap('ShiftRight'); down('Enter'); up('Enter');
    const first = runtime.engines[0];
    tap('KeyJ');
    expect(runtime.engines).toHaveLength(2);
    expect(runtime.engines[1].state).toMatchObject({ stage: 2, mode: 'coop', tick: 0 });
    frame(20); down('KeyJ'); down('KeyK'); frame(); up('KeyJ'); up('KeyK'); frame();
    expect(api.presentation().stage).toBe(2);
    expect(runtime.engines).toHaveLength(2);
    tap('KeyK');
    expect(runtime.engines).toHaveLength(3);
    const selected = runtime.engines[2];
    expect(selected).not.toBe(first);
    expect(selected.state).toMatchObject({ stage: 1, mode: 'coop', tick: 0, rng: seeds[2] });
    expect(selected.state.players).toHaveLength(2);
    expect(api.state()).toBeNull(); expect(runtime.scene!.state).toBeNull();
    down('Enter');
    expect(runtime.engines).toHaveLength(3); expect(seeds).toHaveLength(3);
    expect(runtime.scene!.state).toBe(selected.state);
    expect(api.state()).toMatchObject({ stage: 1, mode: 'coop', tick: 0 });
  });

  it('creates a fresh prepared engine for the next run after returning to the menu', () => {
    const seeds = controlledSeeds();
    down('Enter'); up('Enter'); down('Enter'); up('Enter');
    const previous = runtime.engines[0];
    api.debug({ phase: 'lost' }); api.step(); until('menu');
    expect(api.state()).toBeNull(); expect(runtime.scene!.state).toBeNull();
    tap('ShiftRight'); down('Enter'); up('Enter');
    expect(runtime.engines).toHaveLength(2);
    const next = runtime.engines[1];
    expect(next).not.toBe(previous);
    expect(next.state).toMatchObject({ tick: 0, phase: 'intro', mode: 'coop', rng: seeds[1] });
    expect(next.state.players.map(player => player.score)).toEqual([0, 0]);
    down('Enter');
    expect(runtime.engines).toHaveLength(2); expect(seeds).toHaveLength(2);
    expect(runtime.scene!.state).toBe(next.state);
  });

  it('discards failed preparation and preserves fresh Start construction errors and seeds', () => {
    const seeds = controlledSeeds();
    down('Enter'); up('Enter');
    const discarded = runtime.engines[0];
    const failure = new Error('engine construction failed');
    runtime.engineFailure = failure;
    tap('KeyJ'); tap('KeyK'); frame(10);
    expect(api.presentation()).toMatchObject({ kind: 'stage-select', stage: 1 });
    expect(runtime.engineOptions).toHaveLength(3);
    expect(api.state()).toBeNull(); expect(runtime.scene!.state).toBeNull();
    let caught: unknown;
    try { down('Enter'); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(runtime.engineOptions.map(options => options.seed)).toEqual(seeds);
    expect(seeds).toHaveLength(4);
    expect(runtime.audioSyncStates).toEqual([]);
    up('Enter'); runtime.engineFailure = null; down('Enter');
    expect(runtime.engines).toHaveLength(2); expect(seeds).toHaveLength(5);
    expect(runtime.scene!.state).not.toBe(discarded.state);
    expect(api.state()).toMatchObject({ tick: 0, stage: 1, phase: 'intro', rng: seeds[4] });
  });

  it.each(['Enter', 'blur', 'visibilitychange'] as const)('shows an intro paused by %s and resumes its retained progress', trigger => {
    tap('Enter'); tap('Enter'); frame(7);
    const before = api.presentation();
    expect(before.kind).toBe('intro');
    if (trigger === 'Enter') tap('Enter');
    else loseFocus(trigger);
    expect(api.state()!.phase).toBe('paused');
    expect(api.presentation()).toMatchObject({ kind: 'intro', paused: true, elapsedMs: before.elapsedMs });
    const tick = api.state()!.tick;
    frame(90);
    expect(api.state()!.tick).toBe(tick);
    expect(api.presentation().elapsedMs).toBe(before.elapsedMs);
    Object.assign(document, { hidden: false });
    tap('Enter');
    expect(api.state()!.phase).toBe('intro');
    expect(api.presentation()).toMatchObject({ kind: 'intro', paused: false });
    expect(api.presentation().elapsedMs).toBeGreaterThan(before.elapsedMs!);
    until('game');
    expect(api.state()!.phase).toBe('playing');
  });

  it('selects cooperative stage with independent pads and does not repeat Start across scenes', () => {
    tap('ShiftRight');
    down('Enter'); frame(4); down('Enter', true);
    expect(api.presentation()).toMatchObject({ kind: 'stage-select', stage: 1, mode: 'coop' });
    expect(api.state()).toBeNull();
    up('Enter'); tap('KeyJ'); tap('KeyJ'); tap('KeyK');
    expect(api.presentation().stage).toBe(2);
    tap('Enter'); api.step(250);
    const state = api.state()!;
    const tanks = state.tanks.filter(tank => tank.team === 'player');
    Object.assign(tanks[0], { x: 32, y: 64, direction: 'right', spawnTicks: 0 });
    Object.assign(tanks[1], { x: 160, y: 112, direction: 'left', spawnTicks: 0 });
    // Isolate the two controllers from shots fired by enemies during startup.
    api.debug({ tanks, bullets: [], tiles: Array(676).fill(0), brickMasks: Array(676).fill(0), spawned: 20 });
    down('KeyD'); down('ArrowLeft'); down('KeyK'); down('KeyM'); frame(5);
    expect(api.state()!.tanks.map(tank => tank.x)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(api.state()!.tanks[0].x).toBeGreaterThan(32);
    expect(api.state()!.tanks[1].x).toBeLessThan(160);
    const bullets = api.state()!.bullets;
    expect(bullets).toHaveLength(2);
    expect(bullets.every(bullet => bullet.team === 'player')).toBe(true);
    expect(new Set(bullets.map(bullet => bullet.playerIndex))).toEqual(new Set([0, 1]));
    tap('Enter');
    expect(api.state()!.phase).toBe('paused');
    const paused = api.state()!;
    frame(30);
    expect(api.state()!.tick).toBe(paused.tick);
    tap('Enter'); frame(5);
    expect(api.state()!.tanks[0].x).toBe(paused.tanks[0].x);
    up('KeyD'); down('KeyD'); frame(4);
    expect(api.state()!.tanks[0].x).toBeGreaterThan(paused.tanks[0].x);
  });

  it('keeps half-wall Construction through menu and uses it only for the first stage', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    tap('KeyD'); tap('KeyS'); for (let i = 0; i < 6; i++) tap('KeyJ');
    expect(api.editor()).toMatchObject({ cursor: { x: 1, y: 1 }, selectedCode: 5 });
    const draft = api.getEditorTiles();
    expect([draft[54], draft[55], draft[80], draft[81]]).toEqual([0, 2, 0, 2]);
    tap('Enter'); tap('Enter');
    expect(api.presentation().kind).toBe('stage-select');
    expect(runtime.engines).toHaveLength(0);
    tap('Enter');
    expect(api.state()!.tiles).toEqual(draft);
    expect(runtime.engines).toHaveLength(1);
    const carries = api.state()!.players.map(({ score, lives, stars, nextExtraLife, eliminated }) =>
      ({ score, lives, stars, nextExtraLife, eliminated }));
    api.debug({ phase: 'won' }); api.step();
    until('game');
    expect(runtime.engines).toHaveLength(2);
    expect(runtime.engineOptions[1]).toMatchObject({ stage: 2, mode: 'single', players: carries });
    expect(runtime.engines[1]).not.toBe(runtime.engines[0]);
    expect(api.state()!.stage).toBe(2);
    expect(api.state()!.tiles).not.toEqual(draft);
    expect(api.getEditorTiles()).toEqual(draft);
  });

  it('retains injected cells when another Construction block is painted and played', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    tap('KeyD'); tap('KeyS');
    api.setEditorTile(270, Tile.Water);
    expect(api.getEditorTiles()[270]).toBe(Tile.Water);
    for (let i = 0; i < 6; i++) tap('KeyJ');
    const draft = api.getEditorTiles();
    expect(draft[270]).toBe(Tile.Water);
    expect([draft[54], draft[55], draft[80], draft[81]]).toEqual([Tile.Empty, Tile.Steel, Tile.Empty, Tile.Steel]);
    tap('Enter'); tap('Enter'); tap('Enter');
    expect(api.state()!.tiles).toEqual(draft);
  });

  it.each(['blur', 'visibilitychange'] as const)('moves after %s on the first fresh direction without an in-page keyup', trigger => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    down('KeyD'); frame();
    expect(api.editor().cursor).toEqual({ x: 1, y: 0 });
    loseFocus(trigger); frame(5);
    down('KeyD', true); frame();
    expect(api.editor().cursor).toEqual({ x: 1, y: 0 });
    Object.assign(document, { hidden: false });
    tap('Enter');
    expect(api.presentation().kind).toBe('editor');
    expect(api.editor().cursor).toEqual({ x: 1, y: 0 });
    // The old physical key was released in another window, so no keyup arrived.
    down('KeyD'); frame();
    expect(api.editor().cursor).toEqual({ x: 2, y: 0 });
    up('KeyD');
  });

  it.each(['blur', 'visibilitychange'] as const)('accepts fresh movement and fire after %s without their old keyups', trigger => {
    tap('Enter'); tap('Enter'); until('game');
    const tanks = api.state()!.tanks.filter(tank => tank.team === 'player');
    Object.assign(tanks[0], { x: 32, y: 64, direction: 'right', spawnTicks: 0 });
    api.debug({ tanks, bullets: [], tiles: Array(676).fill(Tile.Empty), brickMasks: Array(676).fill(0), spawned: 20 });
    down('KeyD'); down('KeyJ'); frame();
    expect(api.state()!.tanks[0].x).toBeGreaterThan(32);
    expect(api.state()!.bullets).toHaveLength(1);
    loseFocus(trigger);
    const paused = api.state()!;
    down('KeyD', true); down('KeyJ', true); frame(5);
    expect(api.state()!.phase).toBe('paused');
    expect(api.state()!.tick).toBe(paused.tick);
    Object.assign(document, { hidden: false });
    tap('Enter'); frame(5);
    const resumed = api.state()!;
    expect(resumed.phase).toBe('playing');
    expect(resumed.tanks[0].x).toBe(paused.tanks[0].x);
    // Free the occupied gun slot so a new physical fire edge has an observable shot.
    api.debug({ bullets: [] });
    down('KeyD'); down('KeyJ'); frame();
    expect(api.state()!.tanks[0].x).toBeGreaterThan(resumed.tanks[0].x);
    expect(api.state()!.bullets).toHaveLength(1);
    expect(api.state()!.bullets[0]).toMatchObject({ team: 'player', playerIndex: 0 });
    up('KeyD'); up('KeyJ');
  });

  it.each(['blur', 'visibilitychange'] as const)('resumes on the first fresh Start after %s loses its old keyup', trigger => {
    tap('Enter'); down('Enter'); until('game');
    loseFocus(trigger);
    const tick = api.state()!.tick;
    down('Enter', true); frame(5);
    expect(api.state()!.phase).toBe('paused');
    expect(api.state()!.tick).toBe(tick);
    Object.assign(document, { hidden: false });
    down('Enter'); frame();
    expect(api.state()!.phase).toBe('playing');
    expect(api.state()!.tick).toBeGreaterThan(tick);
    up('Enter');
  });

  it('repeats Construction on held ticks 20 and 25, retaining the timer when direction changes', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    down('KeyD'); frame();
    expect(api.editor().cursor).toEqual({ x: 1, y: 0 });
    frame(18); expect(api.editor().cursor).toEqual({ x: 1, y: 0 });
    frame(); expect(api.editor().cursor).toEqual({ x: 2, y: 0 });
    frame(4); expect(api.editor().cursor).toEqual({ x: 2, y: 0 });
    frame(); expect(api.editor().cursor).toEqual({ x: 3, y: 0 });
    up('KeyD'); down('KeyS'); frame();
    expect(api.editor().cursor).toEqual({ x: 3, y: 1 });
    frame(3); expect(api.editor().cursor).toEqual({ x: 3, y: 1 });
    frame(); expect(api.editor().cursor).toEqual({ x: 3, y: 2 });
    up('KeyS');
  });

  it('reenters Construction with a fresh cursor and first action while preserving the draft', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    tap('KeyD'); tap('KeyS'); tap('KeyJ'); tap('KeyJ');
    const draft = api.getEditorTiles();
    tap('Enter'); tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    expect(api.editor()).toEqual({ cursor: { x: 0, y: 0 }, selectedCode: 0 });
    expect(api.getEditorTiles()).toEqual(draft);
    tap('KeyJ'); expect(api.editor().selectedCode).toBe(0);
  });

  it('freezes editor after blur until Start and releases the held paint action', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    tap('KeyD'); tap('KeyS'); down('KeyJ'); frame();
    const at = api.editor().cursor;
    const before = api.getEditorTiles();
    dispatch('blur'); down('KeyD'); frame(5);
    expect(api.editor().cursor).toEqual(at);
    up('KeyD'); tap('Enter');
    expect(api.presentation().kind).toBe('editor');
    tap('KeyD');
    expect(api.editor().cursor.x).toBe(at.x + 1);
    const index = at.y * 2 * 26 + (at.x + 1) * 2;
    expect(api.getEditorTiles()[index]).toBe(before[index]);
    up('KeyJ');
  });

  it('clears the map on Game Over, displays HISCORE and retains the powered-on record', () => {
    tap('ShiftRight'); tap('ShiftRight'); tap('Enter');
    tap('KeyD'); tap('KeyS'); tap('KeyJ'); tap('KeyJ');
    const edited = api.getEditorTiles();
    tap('Enter'); tap('Enter'); tap('Enter');
    const players = api.state()!.players;
    players[0].score = 45000;
    api.debug({ players, phase: 'lost' }); api.step();
    until('gameover');
    expect(runtime.audioEvents.slice(-3)).toEqual(['gameover', 'tick', 'commit']);
    const gameoverAudioStart = runtime.audioEvents.length - 3;
    expect(api.getEditorTiles()).not.toEqual(edited);
    expect(api.presentation().highScore).toBe(20000);
    frame(108);
    expect(api.presentation()).toMatchObject({ kind: 'gameover', highScore: 20000 });
    frame();
    expect(api.presentation()).toMatchObject({ kind: 'hiscore', highScore: 45000 });
    expect(runtime.audioEvents.slice(gameoverAudioStart, -3).filter(event => event === 'tick')).toHaveLength(109);
    expect(runtime.audioEvents.slice(-3)).toEqual(['hiscore', 'tick', 'commit']);
    const hiscoreAudioStart = runtime.audioEvents.length - 3;
    frame(460);
    expect(api.presentation().kind).toBe('hiscore');
    frame();
    expect(api.presentation().kind).toBe('menu');
    expect(runtime.audioEvents.slice(hiscoreAudioStart, -3).filter(event => event === 'tick')).toHaveLength(461);
    expect(api.presentation().highScore).toBe(45000);
    expect(api.state()).toBeNull();
  });

  it('retains both full cooperative result scores through Game Over and selects the next single-player run independently', () => {
    tap('ShiftRight'); tap('Enter'); tap('Enter');
    const players = api.state()!.players;
    players[0].score = 1_000_000; players[1].score = 1_000_200;
    api.debug({ players, phase: 'lost' }); api.step();
    until('score');
    expect(api.state()!.mode).toBe('coop');
    expect(api.state()!.players.map(player => player.score)).toEqual([1_000_000, 1_000_200]);
    until('gameover'); until('hiscore'); until('menu');
    expect(api.presentation()).toMatchObject({ playerScores: [1_000_000, 1_000_200], highScore: 1_000_200 });
    tap('Enter');
    expect(api.presentation()).toMatchObject({ kind: 'stage-select', mode: 'single' });
    tap('Enter');
    expect(api.state()!.mode).toBe('single');
    expect(api.state()!.players.map(player => player.score)).toEqual([0]);
    api.debug({ phase: 'lost' }); api.step();
    until('gameover'); until('menu');
    expect(api.presentation()).toMatchObject({ playerScores: [0], highScore: 1_000_200 });
  });

  it('uses integer native scaling and never scales below one pixel per native pixel', () => {
    expect(wrapper.style).toEqual({ width: '768px', height: '720px' });
    expect(runtime.canvasSize).toEqual({ width: 768, height: 720 });
    for (const viewport of [
      { width: 320, height: 240, scale: 1 },
      { width: 1280, height: 720, scale: 3 },
      { width: 390, height: 844, scale: 1 },
      { width: 220, height: 180, scale: 1 },
    ]) {
      Object.assign(window, { innerWidth: viewport.width, innerHeight: viewport.height });
      dispatch('resize');
      expect(wrapper.style).toEqual({ width: `${256 * viewport.scale}px`, height: `${240 * viewport.scale}px` });
      expect(runtime.canvasSize).toEqual({ width: 256 * viewport.scale, height: 240 * viewport.scale });
    }
  });

  it('reveals zero-kill results on the measured frames and advances after the full TOTAL hold', () => {
    tap('Enter'); tap('Enter');
    api.debug({ phase: 'lost' }); api.step();
    until('score');
    const timeline = () => scoreTimeline(api.state()!, api.presentation().elapsedMs!);
    frame(34);
    expect(timeline().rows[0].counts).toEqual([null]);
    frame();
    expect(timeline().rows[0].counts).toEqual([0]);
    frame(126);
    expect(timeline().totalVisible).toBe(false);
    frame();
    expect(timeline().totalVisible).toBe(true);
    frame(134);
    expect(api.presentation().kind).toBe('score');
    expect(timeline().totalVisible).toBe(true);
    frame();
    expect(api.presentation().kind).toBe('gameover');
  });
});
