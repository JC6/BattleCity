import { expect, test, type TestInfo } from '@playwright/test';
import { attachPcmFailure, audioMarkTime, audioReady, installPcmProbe, pcmAssert, pcmMeasurement, type PcmMeasurementFailure } from './audio-probe';
import { observePcmShotFailure } from './pcm-window';
import { presentation, ready } from './helpers';

// Native PCM sampling and scene transitions share the desktop case budget.
test.describe.configure({ timeout: 60000 });

function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) };
}
async function attachCountFailure(testInfo: TestInfo, failure: PcmMeasurementFailure,
  scoreAt: number, countAt: number): Promise<void> {
  // Save the same local samples and result that caused this failure.
  await testInfo.attach('audio-count-failure', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ ...failure, error: errorDetails(failure.error), scoreAt, countAt }, null, 2)),
  });
}

async function prepared(page: Parameters<typeof ready>[0]): Promise<void> {
  await installPcmProbe(page, { observeScenes: true }); await ready(page);
  await page.keyboard.press('Enter'); await audioReady(page);
  // Enter already selected the normal single-player stage; finish using Start.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await presentation(page)).kind, { timeout: 12000 }).toBe('game');
}

test('real score counts remain short and GAME OVER music belongs to its presentation page', async ({ page }, testInfo) => {
  await prepared(page);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!; const state = api.state()!;
    state.players[0].kills = [1, 0, 0, 0];
    api.debug({ players: state.players, phase: 'lost', pendingOutcome: 'lost' }); api.step(0);
  });
  const scoreAt = await audioMarkTime(page, 'score', { timeout: 12000 });
  const countAt = await audioMarkTime(page, 'score-count', { after: scoreAt, timeout: 12000 });
  // Count sound must be present after the 35-frame lead and 9-frame count.
  const countFrameTime = (35 + 9) / 60.0988;
  const onFailure = (failure: PcmMeasurementFailure) => attachCountFailure(testInfo, failure, scoreAt, countAt);
  const count = await pcmMeasurement(page, countAt + 0.70 - countFrameTime, countAt + 0.90 - countFrameTime, [], onFailure);
  await observePcmShotFailure(async () => {
    expect(count.features.rms).toBeGreaterThan(0.0005);
  }, () => ({ ...count, stage: 'assertion' as const }), onFailure);
  await pcmAssert(page, countAt + 1.10 - countFrameTime, countAt + 1.30 - countFrameTime, [], value => {
    expect(value.peak).toBeLessThan(0.0001);
  }, failure => attachPcmFailure(testInfo, failure, 'score count silence', { scoreAt, countAt }));
  const musicAt = await audioMarkTime(page, 'gameover', { after: scoreAt, timeout: 12000 });
  await pcmAssert(page, musicAt + 0.03, musicAt + 0.20, [], value => {
    expect(value.rms).toBeGreaterThan(0.004);
  }, failure => attachPcmFailure(testInfo, failure, 'gameover phrase', { scoreAt, countAt, musicAt }));
  const menuAt = await audioMarkTime(page, 'menu', { after: musicAt });
  await pcmAssert(page, menuAt + 0.08, menuAt + 0.25, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'gameover menu silence', { scoreAt, musicAt, menuAt }));
});

test('HISCORE plays its complete reference phrase before returning to a silent menu', async ({ page }, testInfo) => {
  await prepared(page);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!; const state = api.state()!;
    state.players[0].score = 34500;
    api.debug({ players: state.players, phase: 'lost', pendingOutcome: 'lost' }); api.step(0);
  });
  const scoreAt = await audioMarkTime(page, 'score', { timeout: 12000 });
  const gameoverAt = await audioMarkTime(page, 'gameover', { after: scoreAt, timeout: 12000 });
  const recordAt = await audioMarkTime(page, 'hiscore', { after: gameoverAt, timeout: 12000 });
  await pcmAssert(page, recordAt + 0.04, recordAt + 0.24, [], value => {
    expect(value.rms).toBeGreaterThan(0.004);
  }, failure => attachPcmFailure(testInfo, failure, 'hiscore opening', { scoreAt, gameoverAt, recordAt }));
  await pcmAssert(page, recordAt + 6.9, recordAt + 7.1, [], value => {
    expect(value.rms).toBeGreaterThan(0.002);
  }, failure => attachPcmFailure(testInfo, failure, 'hiscore tail', { scoreAt, gameoverAt, recordAt }));
  const menuAt = await audioMarkTime(page, 'menu', { after: recordAt, timeout: 4000 });
  await pcmAssert(page, menuAt + 0.08, menuAt + 0.25, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'hiscore menu silence', { scoreAt, gameoverAt, recordAt, menuAt }));
});
