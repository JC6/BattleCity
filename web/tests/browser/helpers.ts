import { expect, type Page } from '@playwright/test';
import type { GameMode, GameState, PlayerInput, Tile } from '../../src/core/types';
import type { ArenaPresentation, ArenaScene } from '../../src/game/arena';

interface TestHarness {
  state(): GameState | null;
  presentation(): ArenaPresentation;
  start(mode?: GameMode, stage?: number): void;
  step(count?: number, inputs?: PlayerInput[]): void;
  debug(patch: Partial<GameState>): void;
  openEditor(): void;
  setEditorTile(index: number, tile: Tile): void;
  getEditorTiles(): Tile[];
  playEditor(mode?: GameMode): void;
  editor(): { cursor: { x: number; y: number }; selectedCode: number };
  renderScene(): ArenaScene;
}

declare global { interface Window { __BATTLECITY__?: TestHarness } }

const controlledPages = new WeakSet<Page>();
type PresentationKind = ArenaPresentation['kind'];

export async function ready(page: Page): Promise<void> {
  await page.goto('./');
  await page.bringToFront();
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
}

export async function readyWithClock(page: Page): Promise<void> {
  // Install before navigation so Phaser keeps one animation clock origin.
  // Load normally, then pause in the menu before creating an active fixture.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await ready(page);
  expect(await presentation(page)).toMatchObject({ kind: 'menu' });
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.clock.runFor(34);
  controlledPages.add(page);
}

export async function advancePresentation(
  page: Page, from: PresentationKind, to: PresentationKind | readonly PresentationKind[], budgetMs: number,
): Promise<ArenaPresentation> {
  expect(controlledPages.has(page), 'Scene advancement requires readyWithClock').toBe(true);
  const targets: readonly PresentationKind[] = typeof to === 'string' ? [to] : to;
  let frame: { kind: PresentationKind; elapsedMs?: number | null } = await presentation(page);
  expect(frame.kind).toBe(from);
  let advancedMs = 0;
  while (advancedMs < budgetMs) {
    const stepMs = Math.min(250, budgetMs - advancedMs);
    // runFor executes Phaser's actual animation-frame callbacks. Each step is shorter than
    // the two-second scenes; paused RPCs cannot consume their observation window.
    await page.clock.runFor(stepMs);
    advancedMs += stepMs;
    const observed = await page.evaluate(targets => {
      const api = window.__BATTLECITY__!;
      const current = api.renderScene().presentation;
      // Intermediate score frames carry the whole GameState. Observe only
      // progress until the target needs its original, complete snapshot.
      return { kind: current.kind, elapsedMs: 'elapsedMs' in current ? current.elapsedMs : null,
        snapshot: targets.includes(current.kind) ? api.presentation() : null };
    }, targets);
    if (observed.snapshot) return observed.snapshot;
    frame = observed;
    expect(frame.kind, `Unexpected scene after ${advancedMs} ms of animation`).toBe(from);
  }
  const status = await page.evaluate(() => ({
    phase: window.__BATTLECITY__!.state()?.phase ?? null,
    hidden: document.hidden, focused: document.hasFocus(),
  }));
  const elapsedMs = 'elapsedMs' in frame ? frame.elapsedMs : null;
  throw new Error(`${from} did not advance to ${targets.join(' or ')} within ${budgetMs} ms of animation; ` +
    JSON.stringify({ kind: frame.kind, elapsedMs, ...status }));
}

export async function advanceToNextStage(page: Page, stage: number): Promise<void> {
  await advancePresentation(page, 'score', 'intro', 8000);
  // Stop in the intro before gameplay can alter the carried players or map.
  expect(await snapshot(page)).toMatchObject({ stage, phase: 'intro' });
}

export async function begin(page: Page, mode: GameMode = 'single', stage = 1): Promise<void> {
  await page.bringToFront();
  await page.evaluate(({ mode, stage }) => {
    window.__BATTLECITY__!.start(mode, stage);
    window.__BATTLECITY__!.step(250);
  }, { mode, stage });
}

export async function snapshot(page: Page): Promise<GameState | null> {
  return page.evaluate(() => window.__BATTLECITY__!.state());
}

export async function presentation(page: Page): Promise<ArenaPresentation> {
  return page.evaluate(() => window.__BATTLECITY__!.presentation());
}

export async function waitForPlaying(page: Page): Promise<void> {
  if (controlledPages.has(page)) {
    await advancePresentation(page, 'intro', 'game', 2500);
    expect(await snapshot(page)).toMatchObject({ phase: 'playing' });
    return;
  }
  // Allow the fixed-tick intro and browser RPCs to finish on a busy WSL host.
  await expect.poll(() => page.evaluate(() => window.__BATTLECITY__!.state()?.phase), { timeout: 12000 }).toBe('playing');
}

export async function select(page: Page, count = 1): Promise<void> {
  for (let index = 0; index < count; index++) await page.keyboard.press('ShiftRight');
}

export async function startWithKeyboard(page: Page, mode: GameMode = 'single', stage = 1): Promise<void> {
  if (mode === 'coop') await select(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => presentation(page)).toMatchObject({ kind: 'stage-select', stage: 1, mode });
  for (let index = 1; index < stage; index++) {
    await page.keyboard.press('j');
    if (controlledPages.has(page)) await page.clock.runFor(34);
    await expect.poll(() => presentation(page), { intervals: [16, 16, 16] }).toMatchObject({ kind: 'stage-select', stage: index + 1 });
  }
  await page.keyboard.press('Enter');
  await waitForPlaying(page);
}

export async function openWithKeyboard(page: Page): Promise<void> {
  await select(page, 2);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await presentation(page)).kind).toBe('editor');
}

export async function clearStage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    api.debug({ spawned: 20, killed: 20, bullets: [], tanks: state.tanks.filter(tank => tank.team === 'player') });
    api.step(200);
  });
  expect(await presentation(page)).toMatchObject({ kind: 'score' });
}

export async function completeLoss(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.debug({ baseAlive: false });
    api.step(200);
  });
  await advancePresentation(page, 'game', 'score', 2500);
  await advancePresentation(page, 'score', 'gameover', 8000);
  const next = await advancePresentation(page, 'gameover', ['hiscore', 'menu'], 2500);
  if (next.kind === 'hiscore') await advancePresentation(page, 'hiscore', 'menu', 8000);
}
