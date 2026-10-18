import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../../src/app/controller';
import type { AppAudio, AppInput, AppRenderer } from '../../src/app/ports';
import type { ArenaPresentation } from '../../src/app/presentation';
import { EMPTY_INPUT } from '../../src/core/types';
import { TICK_MS } from '../../src/core/constants';
import { INTRO_TICKS } from '../../src/core/rules';

function fixture() {
  const trace: string[] = [];
  const pad = { up: false, right: false, down: false, left: false, a: false, b: false, aPressed: false, bPressed: false };
  const input: AppInput = { read: vi.fn(() => [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }]),
    readPads: vi.fn(() => [{ ...pad }, { ...pad }]), clear: vi.fn(), resetForFocus: vi.fn() };
  const audio: AppAudio = { stopScene: vi.fn(() => trace.push('stop')), syncState: vi.fn(), play: vi.fn(),
    commitFrame: vi.fn(() => trace.push('commit')),
    updateScore: vi.fn(), startPresentation: vi.fn(), setPaused: vi.fn() };
  let presentation: ArenaPresentation = { kind: 'game' };
  const render: AppRenderer = { state: null, hudState: null, draft: null,
    get presentation() { return presentation; },
    set presentation(value) { presentation = value; trace.push(`present:${value.kind}`); },
    resetAnimation: vi.fn(), observeStep: vi.fn() };
  let highScore = 20000;
  const seed = vi.fn(() => 7);
  const controller = new AppController({ input, audio, render, seed,
    records: { getHighScore: () => highScore, highScore: value => highScore = Math.max(highScore, value) } });
  return { controller, api: controller.testing!, audio, input, render, seed, trace };
}
afterEach(() => vi.unstubAllGlobals());

describe('application controller ports', () => {
  it('starts and advances using injected ports with no browser globals', () => {
    vi.stubGlobal('window', undefined); vi.stubGlobal('document', undefined); vi.stubGlobal('crypto', undefined);
    const { controller, api, seed, trace } = fixture();
    controller.startKey(); controller.startKey();
    expect(api.state()!.tick).toBe(0);
    expect(trace.slice(-2)).toEqual(['commit', 'present:intro']);
    controller.frame(TICK_MS);
    expect(seed).toHaveBeenCalledOnce(); expect(api.state()).toMatchObject({ tick: 1, phase: 'intro', rng: 7 });
  });
  it('retains fractional fixed steps, caps stalled frames and submits audio before presentation', () => {
    const { controller, api, trace } = fixture(); api.start(); trace.length = 0;
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(0);
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(1);
    controller.frame(10000); expect(api.state()!.tick).toBe(7);
    expect(trace.slice(-2)).toEqual(['commit', 'present:intro']);
    controller.frame(-100); expect(api.state()!.tick).toBe(7);
  });
  it('drops inactive accumulated time and resumes only from explicit Start', () => {
    const { controller, api, input, audio } = fixture(); api.start();
    controller.frame(TICK_MS / 2); controller.inactive(); controller.frame(1000);
    expect(api.state()).toMatchObject({ tick: 0, phase: 'paused' });
    expect(input.resetForFocus).toHaveBeenCalledOnce(); expect(audio.setPaused).toHaveBeenLastCalledWith(true, 'focus');
    controller.startKey(); controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(0);
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(1);
  });
  it('gives the loss world a clone while keeping the authoritative HUD and result locked', () => {
    const { api, controller, render } = fixture(); api.start(); api.step(INTRO_TICKS);
    api.debug({ baseAlive: false });
    for (let i = 0; i < 1000 && api.presentation().kind !== 'game'; i++) controller.frame(TICK_MS);
    for (let i = 0; i < 1000 && !render.hudState; i++) controller.frame(TICK_MS);
    expect(render.hudState?.phase).toBe('lost'); expect(render.state).not.toBe(render.hudState);
    const result = api.state(); controller.frame(100);
    expect(api.state()).toEqual(result);
    expect(render.state!.tick).toBeGreaterThan(render.hudState!.tick);
  });
  it('isolates test snapshots while rendering the live state without a per-frame clone', () => {
    const { api, controller, render } = fixture(); api.start();
    const borrowed = render.state, copied = api.state()!;
    copied.players[0].lives = 99; copied.tiles.fill(0);
    controller.frame(TICK_MS); expect(render.state).toBe(borrowed);
    expect(api.state()!.players[0].lives).not.toBe(99);
  });
  it('does not accept input or advance audio after idempotent disposal', () => {
    const { controller, api, trace, input } = fixture(); api.start();
    const state = api.state(); controller.dispose(); controller.dispose(); trace.length = 0;
    controller.frame(100); controller.startKey(); controller.selectKey(); controller.inactive();
    expect(api.state()).toEqual(state); expect(trace).toEqual([]);
    expect(input.resetForFocus).toHaveBeenCalledOnce();
  });
});
