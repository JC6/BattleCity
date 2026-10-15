import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCommandCleanup, assertSourceBinding, bindFinalSource, classifyPlaywrightReport, cleanupExitedGroup, command, createCommandCleanup, createLogReader, fingerprintEntries, inspectProductionArtifacts, runtimeEnvironment, saveFinalReport, signalOwnedGroup, stopAndKillOwnedTargets } from './validate-desktop.mjs';

const expected = { chromium: 1, webkit: 1 };
const digest = value => createHash('sha256').update(value).digest('hex');
const validCommand = (patch = {}) => ({
  status: 'passed', exitCode: 0, timedOut: false, interrupted: false,
  startedAt: '2026-10-08T11:59:59.000Z', finishedAt: '2026-10-08T12:00:03.000Z', ...patch,
});
const completedReport = () => ({
  config: { workers: 1, maxFailures: 0, shard: null,
    projects: ['chromium', 'webkit'].map(name => ({ name, retries: 0, repeatEach: 1 })) },
  suites: [{ specs: [{ id: 'controller-start', tests: ['chromium', 'webkit'].map(projectName => ({
    projectName, status: 'expected', expectedStatus: 'passed', results: [{
      status: 'passed', retry: 0, errors: [], startTime: '2026-10-08T12:00:00.500Z', duration: 500,
    }],
  })) }] }],
  errors: [], stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0, startTime: '2026-10-08T12:00:00.000Z', duration: 2000 },
});
const sourceFixture = () => ({
  commit: 'abc', dirty: true, workingTreeFingerprint: 'content',
  licenseSHA256: digest('license'), noticesSHA256: digest('notices'),
});

test('accepts executed passing cases from both desktop engines', () => {
  const verdict = classifyPlaywrightReport(completedReport(), expected, validCommand());
  assert.equal(verdict.status, 'passed');
  assert.equal(verdict.testsExecuted, 2);
});

test('rejects discovery reports with no actual execution', () => {
  const report = completedReport();
  for (const test of report.suites[0].specs[0].tests) test.results = [];
  const verdict = classifyPlaywrightReport(report, expected, validCommand());
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.testsExecuted, 0);
});

test('rejects omitted browser projects even when aggregate claims passed', () => {
  const report = completedReport();
  report.suites[0].specs[0].tests.pop();
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
});

test('rejects skipped or retried failures even when summary claims passed', () => {
  for (const [status, results] of [['skipped', [{ status: 'skipped' }]], ['flaky', [{ status: 'failed' }, { status: 'passed' }]]]) {
    const report = completedReport();
    Object.assign(report.suites[0].specs[0].tests[0], { status, results });
    assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  }
});

test('rejects global errors and nonzero CLI exits despite passing case records', () => {
  const report = completedReport();
  report.errors.push({ message: 'Web server unexpectedly exited' });
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  assert.equal(classifyPlaywrightReport(completedReport(), expected, validCommand({ exitCode: 1 })).status, 'failed');
});

test('rejects a stale result from a previous invocation', () => {
  assert.equal(classifyPlaywrightReport(completedReport(), expected,
    validCommand({ startedAt: '2026-10-08T12:01:00.000Z', finishedAt: '2026-10-08T12:01:03.000Z' })).status, 'failed');
});

test('rejects malformed and impossible report timestamps', () => {
  const report = completedReport();
  report.stats.startTime = 'garbage';
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  report.stats.startTime = '2026-10-08T13:00:00.000Z';
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
});

test('rejects duplicated case records and mismatched configured engines', () => {
  const report = completedReport();
  report.suites[0].specs.push(structuredClone(report.suites[0].specs[0]));
  report.stats.expected = 4;
  assert.equal(classifyPlaywrightReport(report, { chromium: 2, webkit: 2 }, validCommand()).status, 'failed');
  const wrongScope = completedReport();
  wrongScope.config.projects.push({ name: 'firefox' });
  assert.equal(classifyPlaywrightReport(wrongScope, expected, validCommand()).status, 'failed');
});

test('rejects timeout or interruption despite a complete passing report and exit zero', () => {
  assert.equal(classifyPlaywrightReport(completedReport(), expected, validCommand({ status: 'failed', timedOut: true })).status, 'failed');
  assert.equal(classifyPlaywrightReport(completedReport(), expected, validCommand({ status: 'blocked', interrupted: true })).status, 'failed');
});

test('rejects a passing report without a command result', () => {
  assert.equal(classifyPlaywrightReport(completedReport(), expected).status, 'failed');
});

for (const field of ['status', 'exitCode', 'timedOut', 'interrupted', 'startedAt', 'finishedAt']) {
  test(`rejects command evidence missing ${field}`, () => {
    const context = validCommand();
    delete context[field];
    assert.equal(classifyPlaywrightReport(completedReport(), expected, context).status, 'failed');
  });
}

for (const [field, value] of [
  ['status', 'failed'], ['exitCode', 1], ['timedOut', true], ['interrupted', true],
  ['captureError', 'output lost'], ['cleanupError', 'descendant remains'],
  ['startedAt', 'garbage'], ['finishedAt', 'garbage'], ['finishedAt', '2026-10-08T11:59:58.000Z'],
]) {
  test(`rejects invalid command ${field}: ${value}`, () => {
    assert.equal(classifyPlaywrightReport(completedReport(), expected, validCommand({ [field]: value })).status, 'failed');
  });
}

test('rejects a report whose start is current but completion lies outside the command', () => {
  const report = completedReport();
  report.stats.duration = 6000;
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
});

for (const duration of [undefined, 0, -1, Infinity, NaN, '2000']) {
  test(`rejects invalid stage duration ${duration}`, () => {
    const report = completedReport();
    report.stats.duration = duration;
    assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  });
}

for (const [field, value] of [
  ['expectedStatus', undefined], ['expectedStatus', 'failed'], ['expectedStatus', 'skipped'],
]) {
  test(`rejects case ${field} ${value}`, () => {
    const report = completedReport();
    report.suites[0].specs[0].tests[0][field] = value;
    assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  });
}

test('rejects more than one passing attempt for a case', () => {
  const report = completedReport();
  const results = report.suites[0].specs[0].tests[0].results;
  results.push(structuredClone(results[0]));
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
});

for (const [field, value] of [
  ['retry', undefined], ['retry', 1], ['errors', undefined], ['errors', {}], ['errors', [{ message: 'failure' }]],
  ['startTime', undefined], ['startTime', 'garbage'],
  ['startTime', '2026-10-08T11:59:57.999Z'], ['startTime', '2026-10-08T12:00:04.000Z'],
  ['duration', undefined], ['duration', -1], ['duration', Infinity], ['duration', NaN], ['duration', '500'], ['duration', 4000],
]) {
  test(`rejects invalid case result ${field}: ${JSON.stringify(value)}`, () => {
    const report = completedReport();
    report.suites[0].specs[0].tests[0].results[0][field] = value;
    assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
  });
}

test('accepts a zero-duration case and intervals at the existing two-second tolerance', () => {
  const report = completedReport();
  const cases = report.suites[0].specs[0].tests;
  Object.assign(cases[0].results[0], { startTime: '2026-10-08T11:59:58.000Z', duration: 0 });
  Object.assign(cases[1].results[0], { startTime: '2026-10-08T12:00:03.000Z', duration: 1000 });
  assert.equal(classifyPlaywrightReport(report, expected,
    validCommand({ startedAt: '2026-10-08T12:00:00.000Z', finishedAt: '2026-10-08T12:00:02.000Z' })).status, 'passed');
});

test('rejects a case before the CLI tolerance even when its stage interval is current', () => {
  const report = completedReport();
  Object.assign(report.suites[0].specs[0].tests[0].results[0], {
    startTime: '2026-10-08T11:59:59.999Z', duration: 0,
  });
  const verdict = classifyPlaywrightReport(report, expected,
    validCommand({ startedAt: '2026-10-08T12:00:02.000Z' }));
  assert.equal(verdict.status, 'failed');
  assert.deepEqual(verdict.reasons.filter(reason => /outside/.test(reason)), [
    'chromium: case interval is invalid or outside this invocation',
  ]);
});

test('rejects a case ending after the CLI tolerance even when its stage interval is current', () => {
  const report = completedReport();
  Object.assign(report.suites[0].specs[0].tests[0].results[0], {
    startTime: '2026-10-08T12:00:01.501Z', duration: 500,
  });
  const verdict = classifyPlaywrightReport(report, expected,
    validCommand({ finishedAt: '2026-10-08T12:00:00.000Z' }));
  assert.equal(verdict.status, 'failed');
  assert.deepEqual(verdict.reasons.filter(reason => /outside/.test(reason)), [
    'chromium: case interval is invalid or outside this invocation',
  ]);
});

for (const [field, values] of [['workers', [undefined, 2]], ['maxFailures', [undefined, 1]], ['shard', [undefined, { current: 1, total: 2 }]]]) {
  for (const value of values) {
    test(`rejects configuration ${field}: ${JSON.stringify(value)}`, () => {
      const report = completedReport();
      report.config[field] = value;
      assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
    });
  }
}

for (const [field, values] of [['retries', [undefined, 1]], ['repeatEach', [undefined, 2]]]) {
  for (const value of values) {
    test(`rejects project configuration ${field}: ${value}`, () => {
      const report = completedReport();
      report.config.projects[0][field] = value;
      assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
    });
  }
}

test('rejects missing global errors evidence despite passing summary', () => {
  const report = completedReport();
  delete report.errors;
  assert.equal(classifyPlaywrightReport(report, expected, validCommand()).status, 'failed');
});

test('binds source by content, path and deletion with deterministic ordering', () => {
  const file = { path: 'web/src/main.ts', kind: 'file', sha256: createHash('sha256').update('code').digest('hex') };
  const deletion = { path: 'web/src/removed.ts', kind: 'deleted' };
  const original = fingerprintEntries([file, deletion]);
  assert.equal(original, fingerprintEntries([deletion, file]));
  assert.notEqual(original, fingerprintEntries([{ ...file, path: 'web/src/renamed.ts' }, deletion]));
  assert.notEqual(original, fingerprintEntries([file]));
  assert.notEqual(original, fingerprintEntries([{ ...file, sha256: createHash('sha256').update('changed').digest('hex') }, deletion]));
});

test('rejects source changes during execution and missing identity', () => {
  const source = sourceFixture();
  assert.equal(assertSourceBinding(source, { ...source }).status, 'passed');
  assert.equal(assertSourceBinding(source, { ...source, workingTreeFingerprint: 'changed' }).status, 'failed');
  assert.equal(assertSourceBinding(source, { ...source, commit: 'new' }).status, 'failed');
  assert.equal(assertSourceBinding({}, {}).status, 'failed');
});

test('includes root license content and deletion in the source fingerprint', () => {
  const files = [{ path: 'web/src/main.ts', kind: 'file', sha256: digest('code') },
    { path: 'LICENSE', kind: 'file', sha256: digest('license') }];
  const initial = fingerprintEntries(files);
  assert.notEqual(initial, fingerprintEntries([files[0], { ...files[1], sha256: digest('modified license') }]));
  assert.notEqual(initial, fingerprintEntries([files[0], { path: 'LICENSE', kind: 'deleted' }]));
});

for (const field of ['licenseSHA256', 'noticesSHA256']) {
  test(`rejects a source ${field} change even with unchanged commit and web fingerprint`, () => {
    const source = sourceFixture();
    const binding = assertSourceBinding(source, { ...source, [field]: digest('changed') });
    assert.equal(binding.status, 'failed');
    assert.deepEqual(binding.changed, [field]);
  });
  test(`rejects source binding without ${field} on either snapshot`, () => {
    const source = sourceFixture();
    const missing = { ...source };
    delete missing[field];
    assert.equal(assertSourceBinding(source, missing).status, 'failed');
    assert.equal(assertSourceBinding(missing, source).status, 'failed');
    assert.equal(assertSourceBinding(missing, { ...missing }).status, 'failed');
  });
  test(`rejects equal malformed ${field} values`, () => {
    const source = { ...sourceFixture(), [field]: 'invalid' };
    assert.equal(assertSourceBinding(source, { ...source }).status, 'failed');
  });
}

test('final source binding preserves both stable and changed source verdicts', async () => {
  const source = sourceFixture();
  for (const [fingerprint, status] of [['content', 'passed'], ['changed', 'failed']]) {
    const result = await bindFinalSource(source, async () => ({ ...source, workingTreeFingerprint: fingerprint }), new AbortController().signal);
    assert.equal(result.binding.status, status);
    assert.equal(result.fingerprint, fingerprint);
  }
});

test('cancellation before final binding does not start a source scan', async () => {
  const controller = new AbortController();
  controller.abort('SIGINT');
  let scans = 0;
  await assert.rejects(bindFinalSource({}, async () => { scans++; return {}; }, controller.signal), error =>
    error instanceof Error && error.code === 'ABORT_ERR' && /SIGINT/.test(error.message));
  assert.equal(scans, 0);
});

test('cancellation during final source scanning cannot produce a passed binding', async () => {
  const source = sourceFixture();
  const snapshot = Promise.withResolvers();
  const controller = new AbortController();
  const result = bindFinalSource(source, () => snapshot.promise, controller.signal);
  const rejected = assert.rejects(result, error =>
    error instanceof Error && error.code === 'ABORT_ERR' && /SIGTERM/.test(error.message));
  controller.abort('SIGTERM');
  snapshot.resolve({ ...source });
  await rejected;
});

test('final report saving preserves uninterrupted acceptance and preflight statuses', async () => {
  for (const [status, browserAcceptance] of [['passed', 'passed'], ['passed', 'unverified'], ['failed', 'unverified'], ['blocked', 'unverified']]) {
    const report = { schemaVersion: 2, status, browserAcceptance, checks: {} };
    const saved = [];
    await saveFinalReport(report, async () => { saved.push(structuredClone(report)); }, new AbortController().signal);
    assert.deepEqual(saved, [{ schemaVersion: 2, status, browserAcceptance, checks: {} }]);
  }
});

test('cancellation before final report saving persists only blocked acceptance', async () => {
  const report = { schemaVersion: 2, status: 'passed', browserAcceptance: 'passed', checks: {} };
  const controller = new AbortController();
  controller.abort('SIGINT');
  const saved = [];
  await saveFinalReport(report, async () => { saved.push(structuredClone(report)); }, controller.signal);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'blocked');
  assert.equal(saved[0].browserAcceptance, 'unverified');
  assert.match(saved[0].error.message, /SIGINT/);
  assert.deepEqual(saved[0], report);
});

test('cancellation during final report writing waits for a corrected blocked report', async () => {
  const report = { schemaVersion: 2, status: 'passed', browserAcceptance: 'passed', checks: {} };
  const firstSave = Promise.withResolvers();
  const correctionStarted = Promise.withResolvers();
  const correctiveSave = Promise.withResolvers();
  const controller = new AbortController();
  const saved = [];
  const result = saveFinalReport(report, async () => {
    saved.push(structuredClone(report));
    if (saved.length === 1) await firstSave.promise;
    else { correctionStarted.resolve(); await correctiveSave.promise; }
  }, controller.signal);
  let finished = false;
  const completion = result.then(() => { finished = true; });
  assert.equal(saved[0].status, 'passed');
  controller.abort('SIGTERM');
  firstSave.resolve();
  await correctionStarted.promise;
  assert.equal(finished, false, 'Finalization must await persistence of the correction');
  assert.equal(saved.length, 2);
  assert.equal(saved[1].status, 'blocked');
  assert.equal(saved[1].browserAcceptance, 'unverified');
  assert.match(saved[1].error.message, /SIGTERM/);
  correctiveSave.resolve();
  await completion;
  assert.deepEqual(saved[1], report);
});

async function productionFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const license = 'GNU GENERAL PUBLIC LICENSE';
  const notices = 'Arnout Kazemier';
  const expectedLicenses = { licenseSHA256: digest(license), noticesSHA256: digest(notices) };
  try {
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), '<script src="/assets/app.js"></script><link rel="modulepreload" href="/assets/vendor.js">');
    await writeFile(path.join(directory, 'assets/app.js'), 'console.log("game")');
    await writeFile(path.join(directory, 'assets/vendor.js'), 'console.log("vendor")');
    await writeFile(path.join(directory, 'LICENSE.txt'), license);
    await writeFile(path.join(directory, 'THIRD_PARTY_NOTICES.md'), notices);
    await run(directory, expectedLicenses);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('production static evidence includes hashes without claiming browser execution', async () => productionFixture(async (directory, expectedLicenses) => {
  const result = await inspectProductionArtifacts(directory, expectedLicenses);
  assert.equal(result.status, 'passed');
  assert.match(result.scope, /no browser execution/);
  assert.equal(Object.keys(result.assetsSHA256).length, 2);
  assert.deepEqual(result.licensesSHA256, expectedLicenses);
  assert.equal(result.licensesMatchSource, true);
  assert.equal(result.licensesPresent, true);
}));

test('rejects production hooks in a preloaded secondary chunk', async () => productionFixture(async (directory, expectedLicenses) => {
  await writeFile(path.join(directory, 'assets/vendor.js'), 'window.__BATTLECITY__ = {}');
  await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /Test hooks present/);
}));

test('hashes unreferenced worklet chunks and rejects hooks inside them', async () => productionFixture(async (directory, expectedLicenses) => {
  await writeFile(path.join(directory, 'assets/audio-worklet.js'), 'registerProcessor("battlecity", class {})');
  const result = await inspectProductionArtifacts(directory, expectedLicenses);
  assert.match(result.assetsSHA256['/assets/audio-worklet.js'], /^[a-f0-9]{64}$/);
  await writeFile(path.join(directory, 'assets/audio-worklet.js'), 'window.__BATTLECITY__ = {}');
  await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /Test hooks present/);
}));

test('rejects missing production assets', async () => productionFixture(async (directory, expectedLicenses) => {
  await rm(path.join(directory, 'assets/app.js'));
  await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /ENOENT/);
}));

test('rejects missing license content and asset paths outside the production directory', async () => productionFixture(async (directory, expectedLicenses) => {
  await writeFile(path.join(directory, 'LICENSE.txt'), 'placeholder');
  await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /licenses/);
  await writeFile(path.join(directory, 'index.html'), '<script src="/assets/../../outside.js"></script>');
  await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /local \/assets\//);
}));

test('requires production source hashes instead of inferring them from the artifacts', async () => productionFixture(async directory => {
  await assert.rejects(inspectProductionArtifacts(directory), /source license hashes/);
}));

for (const field of ['licenseSHA256', 'noticesSHA256']) {
  for (const value of [undefined, '', 'not-a-hash', 'a'.repeat(63), 'a'.repeat(65)]) {
    test(`rejects invalid expected production ${field}: ${value}`, async () => productionFixture(async (directory, expectedLicenses) => {
      await assert.rejects(inspectProductionArtifacts(directory, { ...expectedLicenses, [field]: value }), /source license hashes/);
    }));
  }
}

for (const [filename, field] of [['LICENSE.txt', 'licenseSHA256'], ['THIRD_PARTY_NOTICES.md', 'noticesSHA256']]) {
  test(`rejects missing production ${filename}`, async () => productionFixture(async (directory, expectedLicenses) => {
    await rm(path.join(directory, filename));
    await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /ENOENT/);
  }));
  test(`rejects production ${filename} that retains its marker but differs from the source`, async () => productionFixture(async (directory, expectedLicenses) => {
    await appendFile(path.join(directory, filename), '\nchanged license text');
    await assert.rejects(inspectProductionArtifacts(directory, expectedLicenses), /initial source snapshot/);
  }));
  test(`rejects a different initial source ${field} even when the production file is unchanged`, async () => productionFixture(async (directory, expectedLicenses) => {
    await assert.rejects(inspectProductionArtifacts(directory, { ...expectedLicenses, [field]: digest('different initial source') }), /initial source snapshot/);
  }));
}

test('spawn failure is reported once without a second close of the log', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  try {
    const result = await command(directory, process.env, 'missing-program', path.join(directory, 'absent'), [], 1000, { quiet: true });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retains console, stream and stderr output through ordinary log file descriptors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  try {
    const result = await command(directory, process.env, 'node-output', process.execPath,
      ['-e', 'console.log("console marker");process.stdout.write("stream marker\\n");console.error("stderr marker");'], 5000, { quiet: true });
    assert.equal(result.status, 'passed');
    assert.match(result.stdout, /console marker\nstream marker/);
    assert.match(await readFile(path.join(directory, result.stdoutLog), 'utf8'), /console marker\nstream marker/);
    assert.match(await readFile(path.join(directory, result.stderrLog), 'utf8'), /stderr marker/);
    assert.match(await readFile(path.join(directory, result.log), 'utf8'), /stderr marker/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('passes explicitly selected runtime paths to child processes without changing the caller environment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const supplied = {
    ...process.env,
    PATH: path.join(directory, 'user-tools'),
    TMPDIR: path.join(directory, 'download-tmp'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'browser-cache'),
    LD_LIBRARY_PATH: path.join(directory, 'user-libs'),
    BATTLECITY_PRODUCTION: '1',
  };
  const original = { ...supplied };
  try {
    const program = 'console.log(JSON.stringify({ paths:Object.fromEntries(["PATH","TMPDIR","PLAYWRIGHT_BROWSERS_PATH","LD_LIBRARY_PATH"].map(key=>[key,process.env[key]])),executable:process.execPath,temporaryDirectory:require("node:os").tmpdir(),production:process.env.BATTLECITY_PRODUCTION??null }));';
    const result = await command(directory, runtimeEnvironment(supplied), 'selected-environment', 'node', ['-e', program], 5000, { quiet: true });
    assert.equal(result.status, 'passed');
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.executable, process.execPath, 'A child selected through PATH uses the current Node');
    assert.equal(actual.paths.PATH, `${path.dirname(process.execPath)}${path.delimiter}${supplied.PATH}`);
    for (const key of ['TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'LD_LIBRARY_PATH']) assert.equal(actual.paths[key], supplied[key]);
    assert.equal(actual.temporaryDirectory, supplied.TMPDIR);
    assert.equal(actual.production, null, 'Full validation starts with the test build');
    assert.deepEqual(supplied, original, 'Preparing child environment does not mutate the terminal environment');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('does not select browser caches or libraries that the caller did not provide', () => {
  const environment = runtimeEnvironment({ PATH: '/usr/bin', TMPDIR: '/selected/downloads' });
  assert.equal(environment.PATH, `${path.dirname(process.execPath)}${path.delimiter}/usr/bin`);
  assert.equal(environment.TMPDIR, '/selected/downloads');
  assert.equal(Object.hasOwn(environment, 'PLAYWRIGHT_BROWSERS_PATH'), false);
  assert.equal(Object.hasOwn(environment, 'LD_LIBRARY_PATH'), false);
});

test('cancellation terminates an owned child and its grandchild before returning', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const pidFile = path.join(directory, 'grandchild.pid');
  const controller = new AbortController();
  const grandchildProgram = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
  const program = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchildProgram)},process.argv[1]],{stdio:"ignore"});setInterval(()=>{},1000);`;
  let grandchild;
  try {
    const running = command(directory, process.env, 'cancel-tree', process.execPath, ['-e', program, pidFile], 5000, { signal: controller.signal, quiet: true });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { grandchild = Number(await readFile(pidFile, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort('test cancellation');
    const result = await running;
    if (!grandchild && /EPERM|EACCES/.test(result.reason ?? result.tail)) { t.skip('Child-process creation restricted'); return; }
    assert.ok(grandchild, 'Grandchild reached the ready marker');
    assert.equal(result.interrupted, true);
    assert.equal(result.status, 'blocked');
    let state = 'gone';
    try { state = (await readFile(`/proc/${grandchild}/status`, 'utf8')).match(/^State:\s+(\w)/m)?.[1]; } catch {}
    assert.ok(state === 'gone' || state === 'Z', `Grandchild still running: ${state}`);
  } finally {
    controller.abort('test cleanup');
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixtureProcess(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, state: fields[0], identity: fields[19] };
  } catch { return undefined; }
}

async function fixturePid(filename) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(filename, 'utf8')); } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Fixture did not reach ${path.basename(filename)}`);
}

async function cleanupFixtureProcess(record) {
  if (!record || (await fixtureProcess(record.pid))?.identity !== record.identity) return;
  try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

test('timeout terminates an owned child and its grandchild before returning', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const readyFile = path.join(directory, 'leader.pid');
  const grandchildFile = path.join(directory, 'grandchild.pid');
  const controller = new AbortController();
  const timeoutMs = 2500;
  const grandchildProgram = 'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
  const program = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchildProgram)},process.argv[2]],{stdio:'ignore'});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  let leader, grandchild, running;
  try {
    running = command(directory, process.env, 'timeout-tree', process.execPath,
      ['-e', program, readyFile, grandchildFile], timeoutMs, { signal: controller.signal, quiet: true });
    const [leaderPid, grandchildPid] = await Promise.all([fixturePid(readyFile), fixturePid(grandchildFile)]);
    [leader, grandchild] = await Promise.all([fixtureProcess(leaderPid), fixtureProcess(grandchildPid)]);
    for (const record of [leader, grandchild]) {
      assert.ok(record && !['Z', 'X'].includes(record.state), 'Both owned processes must reach READY before the deadline');
    }
    const result = await running;
    assert.equal(result.timedOut, true);
    assert.equal(result.interrupted, false, 'The real deadline fires without an explicit abort');
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanupError, undefined);
    assert.equal(result.reason, `Command exceeded ${timeoutMs} ms`);
    for (const record of [leader, grandchild]) {
      const current = await fixtureProcess(record.pid);
      assert.ok(!current || current.identity !== record.identity || current.state === 'Z',
        `Owned process survived the deadline: ${record.pid}`);
    }
  } finally {
    controller.abort('test cleanup');
    if (running) await running;
    await cleanupFixtureProcess(grandchild);
    await cleanupFixtureProcess(leader);
    await rm(directory, { recursive: true, force: true });
  }
});

test('background cancellation cannot leave a child created by a SIGTERM handler', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const readyFile = path.join(directory, 'leader.pid');
  const lateFile = path.join(directory, 'late.pid');
  const controller = new AbortController();
  const childProgram = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
  const program = `const fs=require('node:fs');let scheduled=false;process.on('SIGTERM',()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));},80);});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  let leader, lateChild, running;
  try {
    running = command(directory, process.env, 'cancel-late-child', process.execPath,
      ['-e', program, readyFile, lateFile], 5000, { signal: controller.signal, quiet: true });
    leader = await fixtureProcess(await fixturePid(readyFile));
    controller.abort('late-child regression');
    const result = await running;
    assert.equal(result.status, 'blocked');
    assert.equal(result.interrupted, true);
    assert.equal(result.cleanupError, undefined);
    await new Promise(resolve => setTimeout(resolve, 120));
    try { lateChild = await fixtureProcess(Number(await readFile(lateFile, 'utf8'))); } catch {}
    assert.ok(!lateChild || lateChild.state === 'Z', `Late child survived cancellation: ${lateChild?.pid}`);
    const currentLeader = await fixtureProcess(leader.pid);
    assert.ok(!currentLeader || currentLeader.state === 'Z', 'Original command still running');
  } finally {
    controller.abort('test cleanup');
    if (!lateChild) { try { lateChild = await fixtureProcess(Number(await readFile(lateFile, 'utf8'))); } catch {} }
    await cleanupFixtureProcess(lateChild);
    await cleanupFixtureProcess(leader);
    if (running) await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test('foreground cancellation preserves SIGTERM and waits for its grace cleanup', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const readyFile = path.join(directory, 'leader.pid');
  const termFile = path.join(directory, 'term.txt');
  const controller = new AbortController();
  const program = 'const fs=require("node:fs");process.on("SIGTERM",()=>{fs.writeFileSync(process.argv[2],"SIGTERM");process.exit(0);});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
  let leader, running;
  try {
    running = command(directory, process.env, 'cancel-foreground', process.execPath,
      ['-e', program, readyFile, termFile], 5000, { signal: controller.signal, foreground: true, quiet: true });
    leader = await fixtureProcess(await fixturePid(readyFile));
    const cancelledAt = performance.now();
    controller.abort('foreground regression');
    const result = await running;
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanupError, undefined);
    assert.equal(await readFile(termFile, 'utf8'), 'SIGTERM');
    assert.ok(performance.now() - cancelledAt >= 240, 'Returning must await the 250ms cleanup grace');
  } finally {
    controller.abort('test cleanup');
    await cleanupFixtureProcess(leader);
    if (running) await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test('normal exit fails closed when its group has a live descendant without surviving ownership proof', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const pidFile = path.join(directory, 'child.pid');
  const program = 'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[1],String(child.pid));process.exit(0);';
  let descendant;
  try {
    const result = await command(directory, process.env, 'normal-orphan', process.execPath, ['-e', program, pidFile], 5000, { quiet: true });
    descendant = await fixtureProcess(await fixturePid(pidFile));
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'failed');
    assert.match(result.cleanupError, /ownership|identity/i);
    assert.ok(descendant && !['Z', 'X'].includes(descendant.state), 'Unproven ownership must not cause a numeric group kill');
  } finally {
    if (!descendant) { try { descendant = await fixtureProcess(Number(await readFile(pidFile, 'utf8'))); } catch {} }
    await cleanupFixtureProcess(descendant);
    await rm(directory, { recursive: true, force: true });
  }
});

test('foreground grace closes descendants created after the initial SIGTERM snapshot', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const readyFile = path.join(directory, 'leader.pid');
  const lateFile = path.join(directory, 'late.pid');
  const controller = new AbortController();
  const program = 'const fs=require("node:fs");process.on("SIGTERM",()=>{setTimeout(()=>{const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[2],String(child.pid));},80);});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
  let leader, descendant, running;
  try {
    running = command(directory, process.env, 'foreground-late-child', process.execPath, ['-e', program, readyFile, lateFile], 5000, { signal: controller.signal, foreground: true, quiet: true });
    leader = await fixtureProcess(await fixturePid(readyFile));
    controller.abort('late foreground descendant');
    const result = await running;
    descendant = await fixtureProcess(await fixturePid(lateFile));
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanupError, undefined);
    assert.ok(!descendant || ['Z', 'X'].includes(descendant.state), `Late child remains ${descendant?.state}`);
  } finally {
    controller.abort('test cleanup');
    if (!descendant) { try { descendant = await fixtureProcess(Number(await readFile(lateFile, 'utf8'))); } catch {} }
    await cleanupFixtureProcess(descendant);
    await cleanupFixtureProcess(leader);
    if (running) await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test('retains raw UTF8 logs while bounding returned stdout by bytes at complete characters', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const output = '😀'.repeat(65537) + 'a';
  try {
    const result = await command(directory, process.env, 'bounded-unicode', process.execPath, ['-e', 'process.stdout.write("😀".repeat(65537)+"a");'], 5000, { quiet: true });
    assert.equal(result.status, 'passed');
    assert.equal(result.stdoutBytes, Buffer.byteLength(output));
    assert.equal(result.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 262144);
    assert.ok(Buffer.byteLength(result.tail) <= 65536);
    assert.equal(result.stdout.includes('\uFFFD'), false);
    assert.equal(result.tail.includes('\uFFFD'), false);
    assert.ok(result.stdout.isWellFormed() && result.tail.isWellFormed());
    assert.ok(result.stdout.endsWith('😀'.repeat(10) + 'a'));
    assert.deepEqual(await readFile(path.join(directory, result.stdoutLog)), Buffer.from(output));
    assert.ok((await readFile(path.join(directory, result.log), 'utf8')).includes(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('incremental log reading preserves split UTF8 and complete characters at a byte bound', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const filename = path.join(directory, 'split.stdout.log');
  const output = Buffer.from('🙂🙂🙂');
  const emitted = [];
  const reader = createLogReader(filename, 9, text => emitted.push(text));
  try {
    await writeFile(filename, output.subarray(0, 2));
    await reader.read();
    assert.deepEqual(emitted, [], 'Incomplete UTF8 waits for the next file segment');
    await appendFile(filename, output.subarray(2, 7));
    await reader.read();
    assert.equal(emitted.join(''), '🙂');
    await appendFile(filename, output.subarray(7));
    await reader.read();
    await reader.read();
    assert.equal(emitted.join(''), '🙂🙂🙂', 'Previously read bytes are not emitted again');
    assert.equal(reader.bytes, output.length);
    assert.equal(reader.text, '🙂🙂');
    assert.ok(Buffer.byteLength(reader.text) <= 9);
    assert.deepEqual(await readFile(filename), output);
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test('empty log polls allocate no read buffer and appended chunks reuse one buffer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const filename = path.join(directory, 'idle.stdout.log');
  const emitted = [];
  const reader = createLogReader(filename, 9, text => emitted.push(text));
  const originalAllocate = Buffer.allocUnsafe;
  let allocations = 0;
  try {
    await writeFile(filename, '');
    Buffer.allocUnsafe = function (size, ...args) {
      if (size === 65536) allocations++;
      return Reflect.apply(originalAllocate, this, [size, ...args]);
    };
    for (let index = 0; index < 20; index++) await reader.read();
    assert.equal(allocations, 0);
    assert.equal(reader.bytes, 0);
    const first = `${'a'.repeat(65540)}🙂`;
    await appendFile(filename, first);
    await reader.read();
    assert.equal(allocations, 1, 'Multiple chunks share the lazily allocated buffer');
    const suffix = Buffer.from('😀');
    await appendFile(filename, suffix.subarray(0, 2));
    await reader.read();
    await reader.read();
    assert.equal(emitted.join(''), first);
    await appendFile(filename, suffix.subarray(2));
    await reader.read();
    for (let index = 0; index < 20; index++) await reader.read();
    assert.equal(allocations, 1, 'Later appends and empty polls retain the same buffer');
    assert.equal(emitted.join(''), `${first}😀`);
    assert.equal(reader.bytes, Buffer.byteLength(`${first}😀`));
    assert.equal(reader.text, 'a🙂😀');
    await writeFile(filename, '');
    await assert.rejects(reader.read(), /truncated during capture/);
    assert.equal(allocations, 1);
  } finally {
    Buffer.allocUnsafe = originalAllocate;
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid original bytes do not expand the decoded log tail beyond its byte limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const filename = path.join(directory, 'invalid.stdout.log');
  const raw = Buffer.alloc(15, 0xff);
  const reader = createLogReader(filename, 9);
  try {
    await writeFile(filename, raw);
    await reader.read();
    assert.equal(reader.bytes, 15);
    assert.equal(reader.text, '\uFFFD'.repeat(3));
    assert.equal(Buffer.byteLength(reader.text), 9);
    assert.deepEqual(await readFile(filename), raw);
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test('normal close accepts a vanished group before requiring a spawn identity', async () => {
  const probes = [];
  await cleanupExitedGroup(700, undefined, [], {
    sendSignal: (pid, signal) => { probes.push([pid, signal]); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    readMembers: async () => { assert.fail('A gone group needs no process scan'); },
    readProcess: async () => { assert.fail('A gone group needs no ownership proof'); },
  });
  assert.deepEqual(probes, [[-700, 0]]);
});

test('normal close treats a zombie-only group as exited without using its members as proof', { skip: process.platform !== 'linux' }, async () => {
  const signals = [];
  await cleanupExitedGroup(700, undefined, [], {
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    readMembers: async () => [{ pid: 701, group: 700, state: 'Z' }, { pid: 702, group: 700, state: 'X' }],
    readProcess: async () => { assert.fail('Dead tasks require no kill or ownership inference'); },
  });
  assert.deepEqual(signals, [[-700, 0]]);
});

test('normal close never adopts newly observed members as original group ownership', { skip: process.platform !== 'linux' }, async () => {
  const owner = { pid: 700, identity: '1000', group: 700, session: 700 };
  const member = { pid: 701, identity: '1001', group: 700, session: 700, state: 'S' };
  const signals = [];
  const options = {
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    readMembers: async () => [member],
    readProcess: async pid => pid === member.pid ? member : undefined,
  };
  await assert.rejects(cleanupExitedGroup(owner.pid, owner, [], options), /ownership cannot be proven/);
  assert.ok(signals.every(([, signal]) => signal === 0));
  signals.length = 0;
  await cleanupExitedGroup(owner.pid, owner, [member], options);
  assert.deepEqual(signals, [[-700, 0], [-700, 'SIGKILL']], 'A previously saved surviving birth identity proves the group');
});

test('a cleanup error prevents continuation to a later acceptance command', () => {
  let nextCommand = false;
  assert.throws(() => {
    assertCommandCleanup({ status: 'failed', exitCode: 0, cleanupError: 'ownership cannot be proven' });
    nextCommand = true;
  }, error => error.code === 'CLEANUP_FAILED');
  assert.equal(nextCommand, false);
  assert.doesNotThrow(() => assertCommandCleanup({ status: 'passed' }));
});

test('foreground final cleanup stops parents before discovery and kills leaves before their root with birth guards', async () => {
  const leader = { pid: 700, identity: '1000', parent: 1, state: 'S' };
  const child = { pid: 701, identity: '1001', parent: 700, state: 'S' };
  const grandchild = { pid: 703, identity: '1003', parent: 701, state: 'S' };
  const stranger = { pid: 702, identity: '1002', parent: 999, state: 'S' };
  const reused = { pid: 799, identity: '2000', parent: 700, state: 'S' };
  const records = new Map([leader, child, grandchild, stranger, reused].map(record => [record.pid, record]));
  const signals = [];
  await stopAndKillOwnedTargets([{ ...reused, identity: '1999' }, { ...leader }], {
    readProcess: async pid => records.get(pid),
    readChildren: async pid => {
      assert.equal(records.get(pid).state, 'T', 'Each parent must actually stop before enumerating its children');
      return pid === 700 ? [701, 702] : pid === 701 ? [703] : [];
    },
    sendSignal: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGSTOP') records.get(pid).state = 'T';
    },
  });
  assert.deepEqual(signals, [[700, 'SIGSTOP'], [701, 'SIGSTOP'], [703, 'SIGSTOP'], [703, 'SIGKILL'], [701, 'SIGKILL'], [700, 'SIGKILL']]);
});

test('foreground cleanup releases stopped known processes even when child enumeration fails', async () => {
  const leader = { pid: 700, identity: '1000', parent: 1, state: 'S' };
  const signals = [];
  await assert.rejects(stopAndKillOwnedTargets([leader], {
    readProcess: async () => leader,
    readChildren: async () => { throw new Error('denied children'); },
    sendSignal: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGSTOP') leader.state = 'T'; },
  }), /denied children/);
  assert.deepEqual(signals, [[700, 'SIGSTOP'], [700, 'SIGKILL']]);
});

test('foreground cleanup cannot adopt children from a parent PID reused during enumeration', async () => {
  const owner = { pid: 700, identity: '1000', parent: 1, state: 'S' };
  let current = { ...owner };
  const child = { pid: 701, identity: '2001', parent: 700, state: 'S' };
  const signals = [];
  await stopAndKillOwnedTargets([owner], {
    readProcess: async pid => pid === 700 ? current : child,
    readChildren: async () => { current = { ...current, identity: '2000' }; return [701]; },
    sendSignal: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGSTOP') current.state = 'T'; },
  });
  assert.deepEqual(signals, [[700, 'SIGSTOP']], 'Neither the replacement parent nor its child may be killed');
});

test('non-Linux POSIX cancellation retains owned group cleanup without proc identity', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'battlecity-acceptance-test-'));
  const readyFile = path.join(directory, 'leader.pid');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const controller = new AbortController();
  const program = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
  let leader, running;
  try {
    // Exercise the fallback on a real isolated child. This simulates the POSIX
    // branch; it does not claim execution on an actual macOS browser or host.
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    running = command(directory, process.env, 'cancel-posix', process.execPath,
      ['-e', program, readyFile], 5000, { signal: controller.signal, quiet: true });
    leader = await fixtureProcess(await fixturePid(readyFile));
    controller.abort('POSIX regression');
    const result = await running;
    assert.equal(result.status, 'blocked');
    assert.equal(result.interrupted, true);
    assert.equal(result.cleanupError, undefined, 'Absence of Linux identity must not block existing POSIX cleanup');
    const current = await fixtureProcess(leader.pid);
    assert.ok(!current || current.state === 'Z', 'Owned POSIX child survived cancellation');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    controller.abort('test cleanup');
    await cleanupFixtureProcess(leader);
    if (running) await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test('abort and timeout share one cleanup promise without returning before termination', async () => {
  let completeTermination;
  const termination = new Promise(resolve => { completeTermination = resolve; });
  const signals = [];
  const request = createCommandCleanup(async signal => { signals.push(signal); return termination; },
    () => { assert.fail('A background group needs no second graceful cleanup'); }, false);
  const aborted = request();
  await Promise.resolve();
  const timedOut = request(true);
  assert.equal(timedOut, aborted);
  assert.equal(request(), aborted);
  assert.deepEqual(signals, ['SIGKILL']);
  let finished = false;
  aborted.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, 'Cleanup must wait for termination');
  completeTermination([]);
  await aborted;
  assert.equal(finished, true);
});

test('timeout escalates a pending foreground abort without replacing its cleanup', async () => {
  let finishTerm;
  const term = new Promise(resolve => { finishTerm = resolve; });
  const target = { pid: 123, identity: '400' };
  const signals = [];
  const request = createCommandCleanup(async signal => { signals.push(signal); return term; },
    async (targets, signal) => { assert.deepEqual(targets, [target]); signals.push(signal); }, true);
  const aborted = request();
  await Promise.resolve();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(request(true), aborted);
  finishTerm([target]);
  await aborted;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('timeout releases an already-running foreground grace period', async () => {
  const signals = [];
  const request = createCommandCleanup(async signal => { signals.push(signal); return []; },
    async (_targets, signal) => { signals.push(signal); }, true);
  const aborted = request();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(request(true), aborted);
  await aborted;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('group cleanup rejects missing birth identity and a reused or regrouped leader', async () => {
  const owner = Object.freeze({ pid: 700, identity: '1000', group: 700, session: 700 });
  const signals = [];
  const sendSignal = (pid, signal) => signals.push([pid, signal]);
  for (const invalid of [undefined, { ...owner, group: 701 }, { ...owner, session: 701 }, { ...owner, identity: undefined }]) {
    await assert.rejects(signalOwnedGroup(invalid, [], 'SIGKILL', { readProcess: async () => owner, sendSignal }), /identity/);
  }
  for (const current of [{ ...owner, identity: '2000' }, { ...owner, group: 701 }, { ...owner, session: 701 }]) {
    await assert.rejects(signalOwnedGroup(owner, [owner], 'SIGKILL', { readProcess: async () => current, sendSignal }), /identity changed/);
  }
  assert.deepEqual(signals, [], 'Unproven ownership must never signal the numeric group');
  await signalOwnedGroup(owner, [], 'SIGKILL', { readProcess: async () => owner, sendSignal });
  assert.deepEqual(signals, [[-700, 'SIGKILL']]);
});

test('an exited leader requires a surviving original member, or a group proven already gone', async () => {
  const owner = Object.freeze({ pid: 700, identity: '1000', group: 700, session: 700 });
  const member = { pid: 701, identity: '1001', group: 700, session: 700 };
  const signals = [];
  const sendSignal = (pid, signal) => signals.push([pid, signal]);
  await signalOwnedGroup(owner, [member], 'SIGKILL', {
    readProcess: async pid => pid === member.pid ? member : undefined, sendSignal,
  });
  assert.deepEqual(signals, [[-700, 'SIGKILL']]);
  signals.length = 0;
  await assert.rejects(signalOwnedGroup(owner, [member], 'SIGKILL', {
    readProcess: async pid => pid === member.pid ? { ...member, identity: '2001' } : undefined, sendSignal,
  }), /cannot be proven/);
  assert.deepEqual(signals, [[-700, 0]], 'An existence probe must not become an unproven kill');
  signals.length = 0;
  await signalOwnedGroup(owner, [], 'SIGKILL', {
    readProcess: async () => undefined,
    sendSignal: (pid, signal) => { signals.push([pid, signal]); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.deepEqual(signals, [[-700, 0]]);
});
