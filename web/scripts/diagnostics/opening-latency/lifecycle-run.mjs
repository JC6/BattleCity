import { chromium, webkit, devices, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceSnapshot, hashDirectory } from './common.mjs';
import { installLifecycleTimeline } from './lifecycle-instrument.mjs';
import { installPcmProbe, audioReady, audioTime, audioEventTime, beginPcmCapture,
  pcmMeasurement, pcmIdleWindow, pcmBandWindow, pcmShotWindow } from '../../../tests/browser/audio-probe.ts';
import { probeCanvas, waitForCanvasMenu } from '../../../tests/browser/visual-probes.ts';
import { protectedBattlefield } from '../../../tests/browser/construction-fixture.ts';

export const lifecycleSequence = ['test', 'production'].flatMap((mode, block) => [
  { engine: 'chromium', diagnostic: true },
  { engine: 'webkit', diagnostic: false },
  { engine: 'webkit', diagnostic: true },
  { engine: 'webkit', diagnostic: true },
].map((entry, index) => ({ number: block * 4 + index + 1, mode, ...entry,
  group: `${mode}-${entry.diagnostic ? 'diagnostic' : 'baseline'}` })));

const errorDetails = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack });
const unchanged = (left, right) => left.fingerprint === right.fingerprint && left.commit === right.commit;

/** Retain the exact snapshots already returned by the existing PCM helpers.
 * No additional browser query, clock sample or audio node is introduced. */
export function retainPcmSnapshots(page, record, phase) {
  return new Proxy(page, {
    get(target, property) {
      if (property === 'evaluate') return async (...args) => {
        const value = await target.evaluate(...args);
        if (args[1]?.measure === true && typeof value === 'string') {
          try {
            const snapshot = JSON.parse(value);
            if (!Array.isArray(snapshot.packets)) throw new Error('PCM snapshot lacks packets');
            if (record.snapshots.length >= 256) throw new Error('Diagnostic snapshot retention exceeded 256 reads');
            record.snapshots.push({ phase: phase(), request: args[1], snapshot });
          } catch (error) { record.evidenceErrors.push(errorDetails(error)); }
        }
        return value;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function lifecycle(page, record, attachment) {
  let phase = 'setup';
  const observed = retainPcmSnapshots(page, record, () => phase);
  const step = async (name, kind, parameters, work, assertion) => {
    phase = name;
    const result = record.measurements[name] = { kind, parameters, status: 'running', firstSnapshot: record.snapshots.length };
    try {
      result.value = await work();
      assertion(result.value);
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed'; result.error = errorDetails(error); throw error;
    } finally { result.snapshotCount = record.snapshots.length - result.firstSnapshot; }
    return result.value;
  };
  const window = (name, start, end, assertion) => step(name, 'window', { start, end, frequencies: [] },
    () => pcmMeasurement(observed, start, end, [], failure => {
      record.measurements[name].failure = { ...failure, error: errorDetails(failure.error) };
    }), measurement => assertion(measurement.features));

  // Copy the protected lifecycle case's public-keyboard preparation exactly.
  await page.setViewportSize({ width: 256, height: 240 });
  await page.goto('./'); await page.bringToFront();
  await expect(page.locator('#game-canvas canvas')).toBeVisible(); await waitForCanvasMenu(page);
  await protectedBattlefield(page, attachment);
  await page.keyboard.press('Enter'); await audioReady(page);
  await expect.poll(async () => (await probeCanvas(page)).stageSelect, {
    timeout: 20000, message: 'The canvas must render STAGE 1 before selecting another stage',
  }).toBe(1);
  await page.keyboard.press('j');
  await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(2);
  await beginPcmCapture(page);
  await page.keyboard.press('Enter'); record.anchors.startedAt = await audioEventTime(page, 'Enter');

  const movementBand = Array.from({ length: 45 }, (_, index) => 82 + index / 4);
  const shotBand = Array.from({ length: 27 }, (_, index) => 600 + 25 * index);
  const start = record.anchors.startedAt;
  const idleParameters = { start: start + 266 / 60.0988 + 0.08, end: start + 8, frequencies: movementBand, idle: true };
  const idle = await step('idle', 'idle', idleParameters,
    () => pcmIdleWindow(observed, idleParameters.start, idleParameters.end, movementBand), value => {
      expect(value.rms).toBeGreaterThan(0.001);
    });
  const idleMovementPeak = Math.max(...idle.amplitudes);
  await expect.poll(async () => (await probeCanvas(page)).battleStage, { timeout: 12000 }).toBe(2);
  await page.keyboard.down('w');
  try {
    const movingAt = record.anchors.movingAt = await audioEventTime(page, 'KeyW');
    const minimumAmplitude = Math.max(0.002, idleMovementPeak * 3);
    await step('movement', 'band', { start: movingAt + 0.04, end: movingAt + 0.54, frequencies: movementBand,
      scan: { duration: 0.2, step: 0.05, minimumAmplitude } },
    () => pcmBandWindow(observed, movingAt + 0.04, movingAt + 0.54, movementBand, minimumAmplitude), value => {
      expect(Math.max(...value.amplitudes)).toBeGreaterThan(0.002);
      expect(Math.max(...value.amplitudes)).toBeGreaterThan(idleMovementPeak * 3);
    });
  } finally { await page.keyboard.up('w'); }
  const releasedAt = record.anchors.releasedAt = await audioTime(page);
  const comparison = { duration: 0.025, step: 0.008 };
  const shotIdle = await step('shotIdle', 'idle', { start: releasedAt, end: releasedAt + 1.5,
    frequencies: shotBand, idle: true, comparison },
  () => pcmIdleWindow(observed, releasedAt, releasedAt + 1.5, shotBand, comparison), () => {});
  const idleShotPeak = record.idleShotPeak = Math.max(...shotIdle.amplitudes);
  await page.keyboard.press('j'); const shotAt = record.anchors.shotAt = await audioEventTime(page, 'KeyJ');
  try {
    await step('shot', 'shot', { start: shotAt, end: shotAt + 0.5, frequencies: shotBand,
      minimumAmplitude: Math.max(0.002, idleShotPeak * 3) },
    () => pcmShotWindow(observed, shotAt, shotAt + 0.5, shotBand, Math.max(0.002, idleShotPeak * 3), failure => {
      record.measurements.shot.failure = { ...failure, error: errorDetails(failure.error), idleShotPeak };
    }), value => {
      expect(Math.max(...value.band.amplitudes)).toBeGreaterThan(0.002);
      expect(Math.max(...value.band.amplitudes)).toBeGreaterThan(idleShotPeak * 3);
    });
  } catch { /* Keep the original shot failure, then observe the focus lifecycle. */ }

  await page.keyboard.press('Enter'); const pausedAt = record.anchors.pausedAt = await audioEventTime(page, 'Enter');
  await window('manualPausePhrase', pausedAt + 0.08, pausedAt + 0.22, value => expect(value.rms).toBeGreaterThan(0.003));
  await window('manualPauseSilence', pausedAt + 0.68, pausedAt + 0.82, value => expect(value.peak).toBe(0));
  await page.keyboard.press('Enter'); const resumedAt = record.anchors.resumedAt = await audioEventTime(page, 'Enter');
  await window('manualResume', resumedAt + 0.05, resumedAt + 0.22, value => expect(value.rms).toBeGreaterThan(0.001));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurAt = record.anchors.blurAt = await audioEventTime(page, '', 'blur');
  try { await window('focusSilence', blurAt + 0.04, blurAt + 0.18, value => expect(value.peak).toBe(0)); }
  catch { /* Preserve focus failure and complete the original explicit resume. */ }
  await page.keyboard.press('Enter'); const focusResumeAt = record.anchors.focusResumeAt = await audioEventTime(page, 'Enter');
  await window('focusResume', focusResumeAt + 0.05, focusResumeAt + 0.25, value => {
    expect(value.rms).toBeGreaterThan(0.001); expect(value.peak).toBeLessThan(0.3);
  });
  if (record.mode === 'production') expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
  record.lifecycleCompleted = true;
}

export async function runLifecycle(configFile) {
  const config = JSON.parse(await readFile(configFile, 'utf8')), archive = path.resolve(config.archive);
  if (config.scenario !== 'lifecycle') throw new Error('Expected a lifecycle diagnostic config');
  const write = (name, data, exclusive = false) => writeFile(path.join(archive, name), JSON.stringify(data, null, 2), exclusive ? { flag: 'wx' } : {});
  const before = await sourceSnapshot(config.root), manifest = JSON.parse(await readFile(path.join(archive, 'build-manifest.json'), 'utf8'));
  if (before.fingerprint !== config.sourceFingerprint || manifest.sourceFingerprint !== before.fingerprint) throw new Error('Source changed after build');
  const groupNames = ['test-baseline', 'test-diagnostic', 'production-baseline', 'production-diagnostic'];
  if (JSON.stringify(Object.keys(manifest.groups).sort()) !== JSON.stringify([...groupNames].sort())) throw new Error('Unexpected lifecycle build groups');
  for (const group of groupNames) {
    if (JSON.stringify(await hashDirectory(path.join(archive, 'builds', group))) !== JSON.stringify(manifest.groups[group].hashes)) throw new Error('Build changed: ' + group);
  }
  if (JSON.stringify(await hashDirectory(path.join(archive, 'tools'))) !== JSON.stringify(manifest.toolHashes)) throw new Error('Archived diagnostic tools changed');
  await write('experiment.json', { diagnostic: true, scenario: 'lifecycle', sequence: lifecycleSequence,
    workers: 1, retries: 0, timeoutMs: 60000, sampleRate: 44100,
    browserLifecycle: 'One browser per mode/engine; a fresh context per attempt; no retries or replacement attempts',
    rules: 'Original lifecycle thresholds and PCM windows; shot/focus silence failure retained while later checks continue',
    diagnosticDump: 'Once after all measurements or precondition failure, bounded at 3 seconds; no event replies',
    environment: Object.fromEntries(['PLAYWRIGHT_BROWSERS_PATH', 'LP_NUM_THREADS', 'WEBKIT_SKIA_ENABLE_CPU_RENDERING',
      'WEBKIT_SKIA_CPU_PAINTING_THREADS', 'PULSE_SERVER', 'PULSE_SINK', 'PULSE_CLIENTCONFIG'].map(name => [name, process.env[name]])),
    node: process.version, sourceFingerprint: before.fingerprint, startedAt: new Date().toISOString() }, true);
  await write('source-at-start.json', before, true);
  await mkdir(path.join(archive, 'attempts'));
  await mkdir(path.join(archive, 'raw-traces'));
  const results = [], requests = []; let activeGroup, fatal, listening = false;
  const server = createServer(async (request, response) => {
    const group = activeGroup;
    try {
      if (!group) throw new Error('No active build');
      const pathname = decodeURIComponent(new URL(request.url ?? '/', config.url).pathname);
      const directory = path.join(archive, 'builds', group);
      const filename = path.resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(directory + path.sep)) throw new Error('Path outside build');
      const bytes = await readFile(filename);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/plain' };
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(bytes); requests.push({ group, pathname, status: 200 });
    } catch { response.writeHead(404); response.end('Not found'); requests.push({ group, url: request.url, status: 404 }); }
  });

  async function attempt(browser, item, tracesDirectory) {
    activeGroup = item.group;
    const record = { ...item, diagnosticOnly: true, sourceFingerprint: before.fingerprint, browserVersion: browser.version(),
      startedAt: new Date().toISOString(), anchors: {}, measurements: {}, snapshots: [], pageErrors: [], evidenceErrors: [] };
    const traceName = `${String(item.number).padStart(2, '0')}-${item.engine}-${item.group}`;
    const directory = path.join(archive, 'attempts', traceName);
    record.rawTrace = {
      directory: path.relative(archive, tracesDirectory), name: traceName,
      trace: path.relative(archive, path.join(tracesDirectory, `${traceName}.trace`)),
      network: path.relative(archive, path.join(tracesDirectory, `${traceName}.network`)),
      resources: path.relative(archive, path.join(tracesDirectory, 'resources')),
      status: 'partial-unverified',
      limitation: 'Raw files may be incomplete and lack finalized stacks or sources; they do not replace trace.zip.',
    };
    await mkdir(directory); let context, page, timer, closePromise, tracing = false;
    const closeContext = () => closePromise ??= context.close().catch(error => {
      record.cleanupError = errorDetails(error); throw error;
    });
    const attachment = { attach: async (name, options) => {
      const filename = `${record.attachments?.length ?? 0}-${name}${options.contentType === 'application/json' ? '.json' : '.bin'}`;
      await writeFile(path.join(directory, filename), options.body, { flag: 'wx' });
      (record.attachments ??= []).push({ name, file: filename, contentType: options.contentType });
    } };
    try {
      context = await browser.newContext({ ...devices[item.engine === 'webkit' ? 'Desktop Safari' : 'Desktop Chrome'], baseURL: config.url });
      timer = setTimeout(() => { record.timedOut = true; void closeContext().catch(() => {}); }, 60000);
      await context.tracing.start({ name: traceName, screenshots: false, snapshots: false, sources: true }); tracing = true;
      page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => record.pageErrors.push(errorDetails(error)));
      const scripts = [];
      await installPcmProbe({ addInitScript: async script => { scripts.push(script); } }, { deferRecording: true });
      if (item.diagnostic) scripts.push(`(${installLifecycleTimeline.toString()})();`);
      await page.addInitScript(scripts.join('\n'));
      await lifecycle(page, record, attachment);
    } catch (error) { record.error = errorDetails(error); }
    finally {
      clearTimeout(timer);
      if (item.diagnostic && page && !page.isClosed()) {
        record.harvestAttempted = true;
        let dumpTimer;
        try {
          record.timeline = await Promise.race([
            page.evaluate(() => window.__LIFECYCLE_TRACE__.harvest()),
            new Promise((_, reject) => { dumpTimer = setTimeout(() => reject(new Error('Lifecycle harvest exceeded 3 seconds')), 3000); }),
          ]);
          if (record.timeline.error) record.timelineError = errorDetails(record.timeline.error);
        }
        catch (error) { record.timelineError = errorDetails(error); }
        finally { clearTimeout(dumpTimer); }
      }
      if (page && !page.isClosed() && (record.error || Object.values(record.measurements).some(value => value.status === 'failed'))) {
        try { await page.screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 }); }
        catch (error) { record.screenshotError = errorDetails(error); }
      }
      if (tracing) {
        try {
          await context.tracing.stop({ path: path.join(directory, 'trace.zip') });
          record.rawTrace.status = 'zip-exported';
        }
        catch (error) { record.traceError = errorDetails(error); }
      }
      if (context) {
        try { await closeContext(); record.rawTrace.contextCloseCompleted = true; }
        catch (error) { record.cleanupError = errorDetails(error); }
      }
      record.finishedAt = new Date().toISOString();
      record.record = path.relative(archive, path.join(directory, 'record.json'));
      await write(record.record, record, true);
    }
    const compact = { ...item, record: record.record, lifecycleCompleted: !!record.lifecycleCompleted,
      shot: record.measurements.shot?.status ?? 'unreached', focus: record.measurements.focusSilence?.status ?? 'unreached',
      error: record.error, timedOut: record.timedOut, pageErrors: record.pageErrors, evidenceErrors: record.evidenceErrors,
      traceError: record.traceError, cleanupError: record.cleanupError, timelineError: record.timelineError };
    results.push(compact); await write('results.json', results); console.log(JSON.stringify(compact));
    if (record.cleanupError) throw new Error('Context cleanup failed; stopping before another attempt');
  }

  try {
    const address = new URL(config.url);
    if (address.hostname !== '127.0.0.1') throw new Error('Diagnostic server must bind to loopback');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(address.port), '127.0.0.1', resolve); }); listening = true;
    for (const mode of ['test', 'production']) for (const engine of ['chromium', 'webkit']) {
      const tracesDirectory = path.join(archive, 'raw-traces', `${mode}-${engine}`);
      await mkdir(tracesDirectory);
      const browser = await ({ chromium, webkit })[engine].launch({ tracesDir: tracesDirectory });
      try { for (const item of lifecycleSequence.filter(value => value.mode === mode && value.engine === engine)) await attempt(browser, item, tracesDirectory); }
      finally { await browser.close(); }
    }
  } catch (error) { fatal = errorDetails(error); }
  finally {
    server.closeAllConnections();
    if (listening) await new Promise(resolve => server.close(resolve));
    const after = await sourceSnapshot(config.root);
    await write('source-after.json', after, true); await write('requests.json', requests, true);
    const evidenceIntact = results.every(result => !result.traceError && !result.cleanupError && !result.timedOut && !result.timelineError && !result.evidenceErrors.length && !result.pageErrors.length);
    const complete = results.length === lifecycleSequence.length && !fatal && unchanged(before, after) && evidenceIntact;
    const completion = { diagnostic: true, complete, attempted: results.length, expected: lifecycleSequence.length,
      sourceUnchanged: unchanged(before, after), evidenceIntact, fatal, finishedAt: new Date().toISOString(),
      productAcceptance: 'unverified; diagnostic completion and functional observations are not desktop acceptance' };
    await write('completion.json', completion, true); console.log(JSON.stringify(completion)); process.exitCode = complete ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLifecycle(process.argv[2]);
