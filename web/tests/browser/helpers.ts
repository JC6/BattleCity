import { expect, type Page } from '@playwright/test';
import type { GameMode, GameState, PlayerInput, Tile } from '../../src/core/types';

interface TestHarness {
  state(): GameState | null;
  start(mode?: GameMode, stage?: number): void;
  step(count?: number, inputs?: PlayerInput[]): void;
  debug(patch: Partial<GameState>): void;
  openEditor(): void;
  setEditorTile(index: number, tile: Tile): void;
  getEditorTiles(): Tile[];
  playEditor(mode?: GameMode): void;
}

declare global { interface Window { __BATTLECITY__?: TestHarness } }

export async function ready(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
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
