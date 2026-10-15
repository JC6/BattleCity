import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { attachPcmFailure, audioEventTime, audioReady, audioTime, beginPcmCapture, installPcmProbe, pcmAssert, pcmBandWindow, pcmIdleWindow, pcmShotWindow, waitForAudioTime } from './audio-probe';
import type { PcmShotFailure } from './pcm-window';
import { probeCanvas, waitForCanvasMenu } from './visual-probes';
import { protectedBattlefield } from './construction-fixture';

// Native PCM sampling and keyboard preparation share the desktop case budget.
test.describe.configure({ timeout: 60000 });

function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) };
}
async function attachShotFailure(testInfo: TestInfo, failure: PcmShotFailure, idleShotPeak: number): Promise<void> {
  // Retain the exact snapshot analyzed by the failed assertion. A later read
  // of the PCM tap cannot replace evidence from that original bounded window.
  await testInfo.attach('audio-shot-failure', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ ...failure, error: errorDetails(failure.error), idleShotPeak }, null, 2)),
  });
}

async function stageSelection(page: Page, testInfo: TestInfo, protectPlayer = false): Promise<void> {
  // The first case retains desktop keyboard-to-audio timing coverage. This
  // lifecycle fixture uses native size to limit its extra editor observations.
  if (protectPlayer) await page.setViewportSize({ width: 256, height: 240 });
  await installPcmProbe(page, { deferRecording: protectPlayer }); await page.goto('./'); await page.bringToFront();
  await expect(page.locator('#game-canvas canvas')).toBeVisible(); await waitForCanvasMenu(page);
  if (protectPlayer) {
    await protectedBattlefield(page, testInfo);
  }
  // Normal menu gesture unlocks audio. This suite never installs a fake clock.
  await page.keyboard.press('Enter'); await audioReady(page);
  expect((await probeCanvas(page)).stageSelect).toBe(1);
  await page.keyboard.press('j');
  await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(2);
  if (protectPlayer) await beginPcmCapture(page);
}
async function battle(page: Page): Promise<void> {
  await expect.poll(async () => (await probeCanvas(page)).battleStage, { timeout: 12000 }).toBe(2);
}

test('real game clock and AudioWorklet PCM start the three-voice stage tune with the keyboard', async ({ page }, testInfo) => {
  await stageSelection(page, testInfo);
  const silentAt = await audioTime(page);
  await pcmAssert(page, silentAt, silentAt + 0.12, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'stage-selection silence', { silentAt }));
  await page.keyboard.press('Enter'); const keyAt = await audioEventTime(page, 'Enter');
  // Fixed literal pitches from the reference timer registers, independent of
  // the implementation: C5 pulse, G3 pulse, C3 triangle at the first phrase.
  const opening = await pcmAssert(page, keyAt, keyAt + 0.18, [522.714, 195.57, 130.678], value => {
    expect(value.onset).not.toBeNull(); expect(value.onset!).toBeGreaterThanOrEqual(keyAt);
    expect(value.onset!).toBeLessThanOrEqual(keyAt + 0.09);
    expect(value.rms).toBeGreaterThan(0.008); expect(value.peak).toBeLessThan(0.5);
  }, failure => attachPcmFailure(testInfo, failure, 'stage opening', { keyAt }));
  // Measure a short first-note window rather than a whole-song average.
  await pcmAssert(page, opening.onset! + 0.015, opening.onset! + 0.10, [522.714, 195.57, 130.678], value => {
    expect(value.amplitudes[0]).toBeGreaterThan(0.005);
    expect(value.amplitudes[1]).toBeGreaterThan(0.003);
    expect(value.amplitudes[2]).toBeGreaterThan(0.001);
  }, failure => attachPcmFailure(testInfo, failure, 'stage opening voices', { keyAt, onset: opening.onset! }));
  // The final C6 passage begins at reference driver frame 194, after the
  // first audible write at frame 2. Real scheduling can delay that passage relative
  // to native audio time; validate full raw windows within a finite late range.
  const tail = await pcmBandWindow(page, opening.onset! + (194 - 2) / 60.0988,
    opening.onset! + 6, [1045.428154], 0.003);
  expect(tail.amplitudes[0], 'The final C6 phrase must not be truncated at battlefield entry').toBeGreaterThan(0.003);
  await waitForAudioTime(page, opening.onset! + 4.65);
  // Compositor screenshots are comparatively expensive; keep them outside
  // music sampling so the observation does not delay the fixed game loop.
  await battle(page);
  if (process.env.BATTLECITY_PRODUCTION === '1') expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
});

test('real keyboard movement, shot, manual pause and focus pause preserve the native PCM lifecycle', async ({ page }, testInfo) => {
  await stageSelection(page, testInfo, true); await page.keyboard.press('Enter'); const startedAt = await audioEventTime(page, 'Enter');
  const shotBand = Array.from({ length: 27 }, (_, index) => 600 + 25 * index);
  // ID11 alternates 87/92Hz notes; its positive /16 sweep reaches about
  // 82/87Hz within those notes. Compare that complete source band to idle.
  const movementBand = Array.from({ length: 45 }, (_, index) => 82 + index / 4);
  // Two adjacent complete 250ms windows must contain the reference enemy
  // engine and no C6 tail. Native time alone cannot establish that music ended.
  const idle = await pcmIdleWindow(page, startedAt + 266 / 60.0988 + 0.08,
    startedAt + 8, movementBand);
  expect(idle.rms).toBeGreaterThan(0.001);
  const idleMovementPeak = Math.max(...idle.amplitudes);
  await battle(page);
  await page.keyboard.down('w');
  try {
    const movingAt = await audioEventTime(page, 'KeyW');
    const moving = await pcmBandWindow(page, movingAt + 0.04, movingAt + 0.54, movementBand,
      Math.max(0.002, idleMovementPeak * 3));
    const movingPeak = Math.max(...moving.amplitudes);
    expect(movingPeak).toBeGreaterThan(0.002);
    expect(movingPeak).toBeGreaterThan(idleMovementPeak * 3);
  } finally { await page.keyboard.up('w'); }
  // Re-establish actual idle after release: residual movement harmonics must
  // neither count as a shot nor inflate its comparison baseline.
  const releasedAt = await audioTime(page);
  const shotIdle = await pcmIdleWindow(page, releasedAt, releasedAt + 1.5, shotBand,
    { duration: 0.025, step: 0.008 });
  const idleShotPeak = Math.max(...shotIdle.amplitudes);
  await page.keyboard.press('j'); const shotAt = await audioEventTime(page, 'KeyJ');
  // Match the reference's descending 940/756/608Hz attack in continuous raw
  // PCM. Each tone and the same attack's original 25ms wide-band window must
  // exceed the unchanged idle margin; explosions cannot substitute for a shot.
  const shot = await pcmShotWindow(page, shotAt, shotAt + 0.5, shotBand,
    Math.max(0.002, idleShotPeak * 3), failure => attachShotFailure(testInfo, failure, idleShotPeak));
  const shotPeak = Math.max(...shot.band.amplitudes);
  expect(shotPeak, 'The swept player-shot band must be present above native idle harmonics').toBeGreaterThan(0.002);
  expect(shotPeak).toBeGreaterThan(idleShotPeak * 3);
  // Pause has its own 36-tick phrase; ordinary engine/music are frozen.
  await page.keyboard.press('Enter'); const pausedAt = await audioEventTime(page, 'Enter');
  await pcmAssert(page, pausedAt + 0.08, pausedAt + 0.22, [], value => {
    expect(value.rms).toBeGreaterThan(0.003);
  }, failure => attachPcmFailure(testInfo, failure, 'manual pause phrase', { pausedAt }));
  await pcmAssert(page, pausedAt + 0.68, pausedAt + 0.82, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'manual pause silence', { pausedAt }));
  await page.keyboard.press('Enter'); const resumedAt = await audioEventTime(page, 'Enter');
  await pcmAssert(page, resumedAt + 0.05, resumedAt + 0.22, [], value => {
    expect(value.rms).toBeGreaterThan(0.001);
  }, failure => attachPcmFailure(testInfo, failure, 'manual resume', { resumedAt }));
  // Same focus event as the integration suite; it must be silent immediately,
  // with explicit keyboard Start required to resume and no delayed cue burst.
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); const blurAt = await audioEventTime(page, '', 'blur');
  await pcmAssert(page, blurAt + 0.04, blurAt + 0.18, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'focus pause silence', { blurAt }));
  await page.keyboard.press('Enter'); const focusResumeAt = await audioEventTime(page, 'Enter');
  await pcmAssert(page, focusResumeAt + 0.05, focusResumeAt + 0.25, [], value => {
    expect(value.rms).toBeGreaterThan(0.001); expect(value.peak).toBeLessThan(0.3);
  }, failure => attachPcmFailure(testInfo, failure, 'focus resume', { focusResumeAt }));
  if (process.env.BATTLECITY_PRODUCTION === '1') expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
});
