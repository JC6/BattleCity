import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { attachPcmFailure, audioEventTime, audioReady, audioTime, beginPcmCapture, expectOpeningPcm, installPcmProbe, pcmAssert, pcmBandWindow, pcmIdleWindow, pcmPauseWindow, pcmShotWindow, waitForAudioTime, type PcmOpeningObservation } from './audio-probe';
import { pcmResponseObservation, type PcmResponseObservation, type PcmSnapshot } from './pcm-window';
import { probeCanvas, waitForCanvasMenu } from './visual-probes';
import { protectedBattlefield } from './construction-fixture';

// Native PCM sampling and keyboard preparation share the desktop case budget.
test.describe.configure({ timeout: 60000 });

// Fault injection deliberately closes and replaces a native AudioContext.
// Give it its own worker/browser to isolate that device lifecycle from later
// latency measurements. Context, trace and
// screenshot fixtures still use the standard project configuration.
const recoveryTest = test.extend({
  browser: [async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});

// Keep lifecycle preparation and measurement in a fresh browser, separate from
// recovery and main-thread stall cases. This callback must remain distinct from
// recoveryTest's: Playwright uses worker fixture identity to choose its pool.
const lifecycleTest = test.extend({
  browser: [async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});

declare global { interface Window { __AUDIO_LOAD_FAULT__: { attempts: number; release(): void } } }

async function failFirstModule(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    const fault = window.__AUDIO_LOAD_FAULT__ = { attempts: 0, release: () => {} };
    window.AudioContext = class extends NativeContext {
      constructor(...args: ConstructorParameters<typeof NativeContext>) {
        super(...args);
        const load = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = (url, options) => {
          if (!String(url).includes('/apu-worklet-')) return load(url, options);
          if (++fault.attempts !== 1) return load(url, options);
          // Chromium does not expose this Worklet request to page routing.
          // Keep native fetching/rejection and all audio clocks real; only the
          // first URL and the moment that request is released are controlled.
          return new Promise<void>(resolve => { fault.release = resolve; }).then(() =>
            load(new URL('./assets/__missing-audio-module__.js', location.href).href, options));
        };
      }
    };
  });
}

async function attachOpeningObservation(testInfo: TestInfo, observation: PcmOpeningObservation): Promise<void> {
  await testInfo.attach('audio-opening-observation', {
    contentType: 'application/json', body: Buffer.from(JSON.stringify(observation, null, 2)),
  });
}

async function expectResponse(testInfo: TestInfo, kind: PcmResponseObservation['kind'], keyAt: number,
  onset: number, rate: number, diagnostics?: PcmSnapshot['diagnostics']): Promise<void> {
  const observation = pcmResponseObservation(kind, keyAt, onset, rate, diagnostics);
  await testInfo.attach(`audio-${kind}-response`, {
    contentType: 'application/json', body: Buffer.from(JSON.stringify(observation, null, 2)),
  });
  expect(observation.limitExceeded, `${kind} PCM must start within 150ms (50ms performance target)`).toBe(false);
}

async function stageSelection(page: Page, testInfo: TestInfo, protectPlayer = false): Promise<void> {
  // The first case retains desktop keyboard-to-audio timing coverage. This
  // lifecycle fixture uses native size to limit its extra editor observations.
  if (protectPlayer) await page.setViewportSize({ width: 256, height: 240 });
  await installPcmProbe(page, { deferRecording: protectPlayer, observeDelivery: protectPlayer });
  await page.goto('./'); await page.bringToFront();
  await expect(page.locator('#game-canvas canvas')).toBeVisible(); await waitForCanvasMenu(page);
  if (protectPlayer) {
    await protectedBattlefield(page, testInfo);
  }
  // Normal menu gesture unlocks audio. This suite never installs a fake clock.
  await page.keyboard.press('Enter');
  if (!protectPlayer) await audioReady(page);
  // Audio can already be ready while the canvas still awaits its next frame.
  await expect.poll(async () => (await probeCanvas(page)).stageSelect, {
    timeout: 20000,
    message: 'The canvas must render STAGE 1 before selecting another stage',
  }).toBe(1);
  await page.keyboard.press('j');
  await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(2);
  if (protectPlayer) await beginPcmCapture(page);
}
async function battle(page: Page): Promise<void> {
  await expect.poll(async () => (await probeCanvas(page)).battleStage, { timeout: 12000 }).toBe(2);
}

recoveryTest('a failed Worklet load recovers on a fresh graph and resumes the current scene PCM after another gesture', async ({ page }, testInfo) => {
  await failFirstModule(page);
  await installPcmProbe(page);
  await page.goto('./'); await page.bringToFront(); await waitForCanvasMenu(page);
  await page.keyboard.press('Enter'); await page.waitForFunction(() => window.__AUDIO_LOAD_FAULT__.attempts === 1);
  // Enter the game while initialization is pending, then fail that exact load.
  // Recovery must seek this running scene rather than restarting its melody.
  await page.keyboard.press('Enter'); await page.evaluate(() => window.__AUDIO_LOAD_FAULT__.release());
  await page.waitForFunction(() => window.__AUDIO_PCM__?.context?.state === 'closed');
  const closedAt = await page.evaluate(() => performance.now());
  await page.waitForFunction(at => performance.now() - at >= 1100, closedAt);
  expect(await page.evaluate(() => window.__AUDIO_LOAD_FAULT__.attempts)).toBe(1); // No autonomous retry.
  await page.keyboard.press('ArrowUp'); await audioReady(page);
  expect(await page.evaluate(() => window.__AUDIO_LOAD_FAULT__.attempts)).toBe(2);
  expect(await page.evaluate(() => {
    const pcm = window.__AUDIO_PCM__!;
    return { oldGraphs: pcm.retiredGraphs?.length, oldState: pcm.retiredGraphs?.[0].context.state,
      oldGain: pcm.retiredGraphs?.[0].gain?.gain.value, newState: pcm.context?.state,
      different: pcm.context !== pcm.retiredGraphs?.[0].context,
      reset: pcm.firstReset };
  })).toMatchObject({ oldGraphs: 1, oldState: 'closed', oldGain: 0, newState: 'running', different: true,
    reset: { offset: expect.any(Number), music: expect.arrayContaining([1, 2, 3]) } });
  expect(await page.evaluate(() => window.__AUDIO_PCM__!.firstReset!.offset)).toBeGreaterThan(0);
  const recoveredAt = await audioTime(page);
  await pcmAssert(page, recoveredAt + 0.02, recoveredAt + 0.32, [], value => {
    expect(value.rms).toBeGreaterThan(0.001); expect(value.peak).toBeLessThan(0.5);
  }, failure => attachPcmFailure(testInfo, failure, 'recovered current scene', { recoveredAt }));
  await expect.poll(async () => (await probeCanvas(page)).battleStage, { timeout: 12000 }).toBe(1);
  if (process.env.BATTLECITY_PRODUCTION === '1') expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
});

test('real game clock and AudioWorklet PCM start the three-voice stage tune with the keyboard', async ({ page }, testInfo) => {
  await stageSelection(page, testInfo);
  const silentAt = await audioTime(page);
  await pcmAssert(page, silentAt, silentAt + 0.12, [], value => {
    expect(value.peak).toBe(0);
  }, failure => attachPcmFailure(testInfo, failure, 'stage-selection silence', { silentAt }));
  await page.keyboard.press('Enter'); const keyAt = await audioEventTime(page, 'Enter');
  const onset = await expectOpeningPcm(page, keyAt, {
    checkVoices: true,
    onObservation: observation => attachOpeningObservation(testInfo, observation),
    onFailure: failure => attachPcmFailure(testInfo, failure, 'stage opening', { keyAt }),
  });
  // The final C6 passage begins at reference driver frame 194, after the
  // first audible write at frame 2. Real scheduling can delay that passage relative
  // to native audio time; validate full raw windows within a finite late range.
  const tail = await pcmBandWindow(page, onset + (194 - 2) / 60.0988,
    onset + 6, [1045.428154], 0.003);
  expect(tail.amplitudes[0], 'The final C6 phrase must not be truncated at battlefield entry').toBeGreaterThan(0.003);
  await waitForAudioTime(page, onset + 4.65);
  // Compositor screenshots are comparatively expensive; keep them outside
  // music sampling so the observation does not delay the fixed game loop.
  await battle(page);
  if (process.env.BATTLECITY_PRODUCTION === '1') expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
});

for (const stallMs of [150, 300]) test(`playing PCM continues while the main thread is blocked for ${stallMs}ms`, async ({ page }, testInfo) => {
  await stageSelection(page, testInfo);
  await page.keyboard.press('Enter'); const keyAt = await audioEventTime(page, 'Enter');
  // Receipt must precede this continuation test. WebKit can defer MessagePort
  // delivery until the posting main-thread task returns. Confirm first-note
  // quality before blocking; opening latency remains a separate observation.
  await expectOpeningPcm(page, keyAt, {
    onObservation: observation => attachOpeningObservation(testInfo, observation),
    onFailure: failure => attachPcmFailure(testInfo, failure, 'opening before main-thread stall', { keyAt, stallMs }),
  });
  const blocked = await page.evaluate(stallMs => {
    const context = window.__AUDIO_PCM__!.context!, start = context.currentTime;
    const started = performance.now();
    while (performance.now() - started < stallMs) { /* Intentional native main-thread stall. */ }
    return { start, end: context.currentTime, elapsedMs: performance.now() - started };
  }, stallMs);
  expect(blocked.elapsedMs).toBeGreaterThanOrEqual(stallMs);
  expect(blocked.end - blocked.start).toBeGreaterThanOrEqual(stallMs / 1000 - 0.03);
  await pcmAssert(page, blocked.start + 0.02, blocked.start + stallMs / 1000 - 0.02, [], value => {
    expect(value.rms).toBeGreaterThan(0.008); expect(value.peak).toBeLessThan(0.5);
  }, failure => attachPcmFailure(testInfo, failure, 'continued PCM during main-thread stall', { ...blocked, stallMs }));
});

lifecycleTest('real keyboard movement, shot, manual pause and focus pause preserve the native PCM lifecycle', async ({ page }, testInfo) => {
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
    Math.max(0.002, idleShotPeak * 3), failure => attachPcmFailure(testInfo, failure, 'player shot', { idleShotPeak }),
    // The end of the first confirmed 8ms tone window is a conservative onset
    // bound. Background engine samples cannot establish the shot's response.
    (match, rate, diagnostics) => expectResponse(testInfo, 'shot', shotAt, match.phases[0].start + 0.008, rate, diagnostics));
  const shotPeak = Math.max(...shot.band.amplitudes);
  expect(shotPeak, 'The swept player-shot band must be present above native idle harmonics').toBeGreaterThan(0.002);
  expect(shotPeak).toBeGreaterThan(idleShotPeak * 3);
  // Pause has its own 36-tick phrase; ordinary engine/music are frozen.
  await page.keyboard.press('Enter'); const pausedAt = await audioEventTime(page, 'Enter');
  await pcmPauseWindow(page, pausedAt,
    failure => attachPcmFailure(testInfo, failure, 'manual pause lifecycle', { pausedAt }),
    async (match, rate, diagnostics) => {
      await expectResponse(testInfo, 'pause', pausedAt, match.onset, rate, diagnostics);
      expect(match.phrase.rms).toBeGreaterThan(0.003);
      expect(match.silence.peak).toBe(0);
    });
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
