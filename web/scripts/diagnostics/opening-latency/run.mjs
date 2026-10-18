import { webkit, devices, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { sequence, sourceSnapshot, hashDirectory, analyzeTimeline } from './common.mjs';
import { installTimeline } from './instrument.mjs';
import { installPcmProbe, audioReady, audioTime, audioEventTime, pcmMeasurement } from '../../../tests/browser/audio-probe.ts';
import { probeCanvas, waitForCanvasMenu } from '../../../tests/browser/visual-probes.ts';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')), archive = config.archive;
const write = (name, data) => writeFile(path.join(archive, name), JSON.stringify(data, null, 2));
const errorDetails = error => ({ name: error?.name, message: String(error?.message ?? error), stack: error?.stack });
try { await access(path.join(archive, 'experiment.json')); throw new Error('This archive already has a run; attempts cannot be replaced'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const before = await sourceSnapshot(config.root), manifest = JSON.parse(await readFile(path.join(archive, 'build-manifest.json'), 'utf8'));
if (before.fingerprint !== config.sourceFingerprint) throw new Error('Source changed after build');
for (const group of ['A', 'B', 'C']) {
  const hashes = await hashDirectory(path.join(archive, 'builds', group));
  if (JSON.stringify(hashes) !== JSON.stringify(manifest.groups[group].hashes)) throw new Error('Build changed: ' + group);
}
await write('source-at-start.json', before);
await write('experiment.json', { sequence, openingBudgetMs: 90, captureMs: 180, silenceMs: 120,
  amplitude: { rmsGreaterThan: .008, peakLessThan: .5, onsetThreshold: .002 },
  device: devices['Desktop Safari'], workers: 1, retries: 0, sampleRate: 44100, browserVersion: '26.6',
  browserLifecycle: 'One fresh browser per three-attempt block; fresh context per attempt; all attempts retained',
  diagnosticDump: 'One request only after the original 180ms PCM measurement completes; never a playback acknowledgement',
  environment: Object.fromEntries(['PLAYWRIGHT_BROWSERS_PATH', 'LP_NUM_THREADS', 'WEBKIT_SKIA_ENABLE_CPU_RENDERING',
    'WEBKIT_SKIA_CPU_PAINTING_THREADS', 'PULSE_SERVER', 'PULSE_SINK', 'PULSE_CLIENTCONFIG'].map(name => [name, process.env[name]])),
  node: process.version, sourceFingerprint: before.fingerprint, startedAt: new Date().toISOString() });

const results = [], requests = []; let activeGroup = 'A', fatal;
const server = createServer(async (request, response) => {
  const group = activeGroup;
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', config.url).pathname);
    const directory = path.join(archive, 'builds', group), filename = path.resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(directory + '/')) throw new Error('Path outside build');
    const bytes = await readFile(filename);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/plain' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
    requests.push({ group, pathname, status: 200 });
  } catch { response.writeHead(404); response.end('Not found'); requests.push({ group, url: request.url, status: 404 }); }
});

async function attempt(browser, item) {
  activeGroup = item.group;
  const record = { ...item, startedAt: new Date().toISOString(), sourceFingerprint: before.fingerprint,
    browserVersion: browser.version(), measurementValid: false, pageErrors: [] };
  const directory = path.join(archive, 'attempts', `${String(item.number).padStart(2, '0')}-${item.group}`);
  await mkdir(directory, { recursive: true });
  let context, page, timer, tracing = false;
  try {
    context = await browser.newContext({ ...devices['Desktop Safari'], baseURL: config.url });
    timer = setTimeout(() => { record.timedOut = true; void context.close().catch(() => {}); }, 60000);
    await context.tracing.start({ screenshots: false, snapshots: false, sources: true }); tracing = true;
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => record.pageErrors.push(errorDetails(error)));
    if (item.group === 'A') await installPcmProbe(page);
    else {
      const scripts = [];
      await installPcmProbe({ addInitScript: async source => { scripts.push(source); } });
      // Playwright does not promise ordering between separate init scripts.
      await page.addInitScript(scripts.join('\n') + `\n(${installTimeline.toString()})();`);
    }
    await page.goto('./'); await page.bringToFront();
    if (item.group !== 'C') { await expect(page.locator('#game-canvas canvas')).toBeVisible(); await waitForCanvasMenu(page); }
    else await expect(page.locator('body')).toHaveAttribute('data-stage', '0');
    await page.keyboard.press('Enter'); await audioReady(page);
    if (item.group !== 'C') await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(1);
    else await expect(page.locator('body')).toHaveAttribute('data-stage', '1');
    await page.keyboard.press('j');
    if (item.group !== 'C') await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(2);
    else await expect(page.locator('body')).toHaveAttribute('data-stage', '2');
    const silentAt = await audioTime(page);
    record.silence = await pcmMeasurement(page, silentAt, silentAt + .12);
    expect(record.silence.features.peak).toBe(0);
    await page.keyboard.press('Enter'); record.keyAt = await audioEventTime(page, 'Enter');
    record.measurement = await pcmMeasurement(page, record.keyAt, record.keyAt + .18, [522.714, 195.57, 130.678], failure => {
      record.measurementFailure = { ...failure, error: errorDetails(failure.error) };
    });
    const features = record.measurement.features;
    if (features.rate !== 44100) throw new Error('Unexpected sample rate: ' + features.rate);
    record.measurementValid = true;
    record.onsetMs = features.onset === null ? null : (features.onset - record.keyAt) * 1000;
    record.passed90ms = features.onset !== null && features.onset >= record.keyAt && features.onset <= record.keyAt + .09;
    record.amplitudePassed = features.rms > .008 && features.peak < .5;
    record.outcome = features.onset === null ? 'no-onset-in-180ms' : !record.passed90ms ? 'late-onset' : !record.amplitudePassed ? 'amplitude-failed' : 'within-budget';
    if (item.group !== 'A') {
      try { record.timeline = await page.evaluate(() => window.__OPENING_TRACE__.harvest()); }
      catch (error) { record.timelineError = errorDetails(error); }
    }
    record.segments = analyzeTimeline(record);
  } catch (error) { record.error = errorDetails(error); record.outcome = record.timedOut ? 'attempt-timeout' : 'measurement-incomplete'; }
  finally {
    clearTimeout(timer);
    const failure = record.outcome !== 'within-budget' || record.pageErrors.length || record.segments?.status === 'incomplete';
    if (failure && page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 }); }
      catch (error) { record.screenshotError = errorDetails(error); }
    }
    if (tracing) {
      try { await context.tracing.stop(failure ? { path: path.join(directory, 'trace.zip') } : {}); }
      catch (error) { record.traceError = errorDetails(error); }
    }
    if (context) { try { await context.close(); } catch (error) { record.cleanupError = errorDetails(error); } }
    record.finishedAt = new Date().toISOString();
    record.record = path.relative(archive, path.join(directory, 'record.json'));
    await write(record.record, record);
  }
  const compact = { ...item, record: record.record, outcome: record.outcome, onsetMs: record.onsetMs,
    measurementValid: record.measurementValid, passed90ms: record.passed90ms, amplitudePassed: record.amplitudePassed,
    diagnosticStatus: record.segments?.status, mainMs: record.segments?.mainMs, audioMs: record.segments?.audioMs,
    issues: record.segments?.issues, error: record.error, pageErrors: record.pageErrors, cleanupError: record.cleanupError };
  results.push(compact); await write('results.json', results); console.log(JSON.stringify(compact));
  if (record.cleanupError) throw new Error('Context cleanup failed; stopping before the next attempt');
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
  for (let block = 1; block <= 24; block++) {
    const browser = await webkit.launch();
    try {
      if (browser.version() !== '26.6') throw new Error('Unexpected WebKit: ' + browser.version());
      for (const item of sequence.filter(item => item.block === block)) await attempt(browser, item);
    } finally { await browser.close(); }
  }
} catch (error) { fatal = errorDetails(error); }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  const after = await sourceSnapshot(config.root);
  await write('source-after.json', after); await write('requests.json', requests);
  const complete = results.length === 72 && !fatal && before.fingerprint === after.fingerprint && before.commit === after.commit;
  const completion = { complete, attempted: results.length, expected: 72, sourceUnchanged: before.fingerprint === after.fingerprint,
    fatal, finishedAt: new Date().toISOString(), productAcceptance: 'unverified; diagnostic completion is not acceptance' };
  await write('completion.json', completion); console.log(JSON.stringify(completion)); process.exitCode = complete ? 0 : 1;
}
