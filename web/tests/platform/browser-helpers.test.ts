import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import type { ArenaPresentation } from '../../src/app/presentation';
import { advancePresentation, readyWithClock } from '../browser/helpers';
import { canvasScreenshot } from '../browser/native-pixels';

vi.mock('@playwright/test', async () => {
  const { expect } = await import('vitest');
  return { expect: (value: unknown, message?: string) => {
    if (value && typeof value === 'object' && 'isVisible' in value) {
      return { toBeVisible: async () => expect(await (value as { isVisible(): Promise<boolean> }).isVisible()).toBe(true) };
    }
    return expect(value, message);
  } };
});

async function controlledPage() {
  const state = new GameEngine(getLevel(1), { mode: 'single', stage: 1 }).state;
  const scene: { presentation: ArenaPresentation } = {
    presentation: { kind: 'menu', selection: 0, highScore: 20000, playerScores: [] },
  };
  const frames: ArenaPresentation[] = [], payloads: unknown[] = [];
  const api = {
    presentation: vi.fn(() => structuredClone(scene.presentation)),
    renderScene: vi.fn(() => scene),
    state: () => structuredClone(state),
  };
  vi.stubGlobal('window', { __BATTLECITY__: api });
  vi.stubGlobal('document', { hidden: false, hasFocus: () => true });
  const page = {
    goto: async () => {}, bringToFront: async () => {},
    locator: () => ({ isVisible: async () => true }),
    waitForFunction: async (callback: () => unknown) => callback(),
    // Execute the real injected callback and copy its RPC result; returning a
    // scene reference here would hide full-state serialization regressions.
    evaluate: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
      const payload = structuredClone(callback(argument));
      payloads.push(payload);
      return payload;
    }),
    clock: {
      install: async () => {}, pauseAt: async () => {},
      runFor: vi.fn(async (duration: number) => {
        const next = frames.shift();
        if (next) scene.presentation = next;
        else if ('elapsedMs' in scene.presentation) scene.presentation.elapsedMs += duration;
      }),
    },
  };
  await readyWithClock(page as unknown as Page);
  page.clock.runFor.mockClear(); page.evaluate.mockClear();
  api.presentation.mockClear(); api.renderScene.mockClear(); payloads.length = 0;
  return { page: page as unknown as Page, clock: page.clock, scene, frames, payloads, api, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('controlled browser scene advancement', () => {
  it('omits intermediate score state while returning the fresh complete target in its observation RPC', async () => {
    const { page, scene, frames, payloads, api, state } = await controlledPage();
    scene.presentation = { kind: 'score', state, highScore: 34500, elapsedMs: 0 };
    frames.push({ kind: 'score', state, highScore: 34500, elapsedMs: 250 },
      { kind: 'score', state, highScore: 34500, elapsedMs: 500 },
      { kind: 'hiscore', highScore: 34500, tick: 17 });
    expect(await advancePresentation(page, 'score', 'hiscore', 1000)).toEqual({ kind: 'hiscore', highScore: 34500, tick: 17 });
    expect(api.presentation).toHaveBeenCalledTimes(2);
    expect(payloads.slice(1, 3)).toEqual([
      { kind: 'score', elapsedMs: 250, snapshot: null },
      { kind: 'score', elapsedMs: 500, snapshot: null },
    ]);
    const callsBeforeTarget = api.presentation.mock.calls.length;
    scene.presentation = { kind: 'game' };
    frames.push({ kind: 'score', state, highScore: 34500, elapsedMs: 123 });
    const target = await advancePresentation(page, 'game', ['score', 'menu'], 250);
    expect(target).toEqual({ kind: 'score', state, highScore: 34500, elapsedMs: 123 });
    expect(api.presentation).toHaveBeenCalledTimes(callsBeforeTarget + 2);
    expect(payloads.at(-1)).toEqual({ kind: 'score', elapsedMs: 123, snapshot: target });
    state.players[0].score = 1000;
    expect(target.kind === 'score' && target.state.players[0].score).toBe(0);
  });

  it('rejects the initial kind before advancing the clock', async () => {
    const { page, clock, scene, api } = await controlledPage();
    scene.presentation = { kind: 'game' };
    await expect(advancePresentation(page, 'intro', 'game', 1000)).rejects.toThrow(/intro/);
    expect(clock.runFor).not.toHaveBeenCalled();
    expect(api.renderScene).not.toHaveBeenCalled();
  });

  it('rejects an unexpected intermediate kind before a later target can hide it', async () => {
    const { page, clock, scene, frames } = await controlledPage();
    scene.presentation = { kind: 'intro', stage: 1, elapsedMs: 0 };
    frames.push({ kind: 'intro', stage: 1, elapsedMs: 250 }, { kind: 'editor' }, { kind: 'game' });
    await expect(advancePresentation(page, 'intro', 'game', 1000)).rejects.toThrow('Unexpected scene after 500 ms of animation');
    expect(clock.runFor.mock.calls.map(([duration]) => duration)).toEqual([250, 250]);
    expect(frames).toEqual([{ kind: 'game' }]);
  });

  it('keeps the exact animation budget and reports the latest elapsed progress on failure', async () => {
    const { page, clock, scene, state } = await controlledPage();
    state.phase = 'playing';
    scene.presentation = { kind: 'score', state, highScore: 34500, elapsedMs: 0 };
    await expect(advancePresentation(page, 'score', 'gameover', 625)).rejects.toThrow(
      'score did not advance to gameover within 625 ms of animation; {"kind":"score","elapsedMs":625,"phase":"playing","hidden":false,"focused":true}',
    );
    expect(clock.runFor.mock.calls.map(([duration]) => duration)).toEqual([250, 250, 125]);
  });
});


describe('canvas compositor capture', () => {
  function capturePage() {
    const box = { x: 0, y: 0, width: 256, height: 240 };
    const viewport = { scrollX: 0, scrollY: 0, innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1 };
    vi.stubGlobal('window', viewport);
    const clipped = Buffer.from('page compositor'), fallback = Buffer.from('element compositor');
    const canvas = {
      evaluate: vi.fn(async function (this: unknown, callback: (element: Element) => unknown) {
        expect(this).toBe(canvas);
        // Execute the real DOM callback; the mock does not decide the clip or path.
        return structuredClone(callback({ getBoundingClientRect: () => ({ ...box }) } as unknown as Element));
      }),
      screenshot: vi.fn(async function (this: unknown, _options: unknown) { expect(this).toBe(canvas); return fallback; }),
    };
    const rawPage = {
      locator: function (this: unknown, selector: string) { expect(this).toBe(rawPage); expect(selector).toBe('#game-canvas canvas'); return canvas; },
      screenshot: vi.fn(async function (this: unknown, _options: unknown) { expect(this).toBe(rawPage); return clipped; }),
    };
    return { page: rawPage as unknown as Page, rawPage, canvas, box, viewport, clipped, fallback };
  }

  it('captures viewport-edge and fractional canvas bounds in CSS pixels at either DPR', async () => {
    for (const dpr of [1, 2]) {
      const value = capturePage(); value.viewport.devicePixelRatio = dpr;
      value.viewport.innerWidth = 256; value.viewport.innerHeight = 240;
      await expect(canvasScreenshot(value.page)).resolves.toBe(value.clipped);
      expect(value.rawPage.screenshot).toHaveBeenLastCalledWith({ clip: { x: 0, y: 0, width: 256, height: 240 }, scale: 'css' });
      value.viewport.innerWidth = 1024; value.viewport.innerHeight = 768;
      Object.assign(value.box, { x: 10.5, y: 20.25 });
      await canvasScreenshot(value.page);
      expect(value.rawPage.screenshot).toHaveBeenLastCalledWith({ clip: { x: 10, y: 20, width: 257, height: 241 }, scale: 'css' });
      Object.assign(value.box, { x: 10.0004, y: 20.0004 });
      await canvasScreenshot(value.page);
      expect(value.rawPage.screenshot).toHaveBeenLastCalledWith({ clip: { x: 10, y: 20, width: 256, height: 240 }, scale: 'css' });
      expect(value.canvas.screenshot).not.toHaveBeenCalled();
    }
  });

  it('retains element capture for scrolled, clipped, invalid or outward-rounded bounds', async () => {
    const cases: [Partial<ReturnType<typeof capturePage>['box']>, Partial<ReturnType<typeof capturePage>['viewport']>][] = [
      [{}, { scrollX: 1 }], [{}, { scrollY: -0.5 }], [{ x: -1 }, {}], [{ x: 900 }, {}], [{ y: 700 }, {}],
      [{ width: 0 }, {}], [{ height: -1 }, {}], [{ x: NaN }, {}], [{ y: Infinity }, {}], [{}, { innerHeight: NaN }],
      [{ width: 0.0001 }, {}], [{ width: 255.5 }, { innerWidth: 255.5 }],
    ];
    for (const [box, viewport] of cases) {
      const value = capturePage(); Object.assign(value.box, box); Object.assign(value.viewport, viewport);
      await expect(canvasScreenshot(value.page)).resolves.toBe(value.fallback);
      expect(value.canvas.screenshot).toHaveBeenCalledOnce();
      expect(value.canvas.screenshot).toHaveBeenCalledWith({ scale: 'css' });
      expect(value.rawPage.screenshot).not.toHaveBeenCalled();
    }
  });

  it('reads current canvas and viewport bounds again after a resize instead of silently clipping a cached rectangle', async () => {
    const value = capturePage();
    await expect(canvasScreenshot(value.page)).resolves.toBe(value.clipped);
    value.viewport.innerWidth = 128;
    await expect(canvasScreenshot(value.page)).resolves.toBe(value.fallback);
    Object.assign(value.box, { width: 512, height: 480 });
    Object.assign(value.viewport, { innerWidth: 512, innerHeight: 480 });
    await expect(canvasScreenshot(value.page)).resolves.toBe(value.clipped);
    expect(value.rawPage.screenshot).toHaveBeenLastCalledWith({ clip: { x: 0, y: 0, width: 512, height: 480 }, scale: 'css' });
    expect(value.canvas.evaluate).toHaveBeenCalledTimes(3);
    expect(value.canvas.screenshot).toHaveBeenCalledOnce();
  });

  it('preserves evaluation and screenshot errors without retrying another capture path', async () => {
    for (const failure of ['evaluate', 'page', 'element'] as const) {
      const value = capturePage(), originalError = new Error(`Original ${failure} failure`);
      if (failure === 'evaluate') value.canvas.evaluate.mockRejectedValue(originalError);
      else if (failure === 'page') value.rawPage.screenshot.mockRejectedValue(originalError);
      else { value.viewport.scrollY = 1; value.canvas.screenshot.mockRejectedValue(originalError); }
      await expect(canvasScreenshot(value.page)).rejects.toBe(originalError);
      expect(value.canvas.evaluate).toHaveBeenCalledOnce();
      expect(value.rawPage.screenshot).toHaveBeenCalledTimes(failure === 'page' ? 1 : 0);
      expect(value.canvas.screenshot).toHaveBeenCalledTimes(failure === 'element' ? 1 : 0);
    }
  });
});
