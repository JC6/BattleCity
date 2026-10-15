import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = path.resolve(path.dirname(scriptPath), '..');
const repoRoot = path.resolve(webRoot, '..');
const expectedCases = { e2e: { chromium: 52, webkit: 52 }, production: { chromium: 12, webkit: 12 } };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validSHA256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };

export function fingerprintEntries(entries) {
  const digest = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    digest.update(`${entry.path}\0`);
    if (entry.kind === 'deleted') digest.update('deleted');
    else if (entry.kind === 'symlink') digest.update(`symlink\0${entry.target}`);
    else digest.update(Buffer.from(entry.sha256, 'hex'));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function assertSourceBinding(before, after) {
  const fields = ['commit', 'dirty', 'workingTreeFingerprint', 'licenseSHA256', 'noticesSHA256'];
  const changed = fields.filter(field => before[field] === undefined || before[field] !== after[field] ||
    (field.endsWith('SHA256') && (!validSHA256(before[field]) || !validSHA256(after[field]))));
  return { status: changed.length ? 'failed' : 'passed', changed,
    reason: changed.length ? `Source identity changed: ${changed.join(', ')}` : 'One source revision throughout the run' };
}

function throwIfInterrupted(signal) {
  if (signal?.aborted) throw Object.assign(new Error(`Validation interrupted by ${signal.reason}`), { code: 'ABORT_ERR' });
}

export async function bindFinalSource(before, captureSnapshot, signal) {
  throwIfInterrupted(signal);
  const after = await captureSnapshot();
  throwIfInterrupted(signal);
  return { binding: assertSourceBinding(before, after), fingerprint: after.workingTreeFingerprint };
}

export async function saveFinalReport(report, save, signal) {
  const markInterrupted = () => {
    try { throwIfInterrupted(signal); }
    catch (error) {
      report.status = 'blocked';
      report.browserAcceptance = 'unverified';
      report.error = { message: error.message, stack: error.stack };
    }
  };
  const interruptedBeforeSave = signal?.aborted;
  if (interruptedBeforeSave) markInterrupted();
  await save();
  if (!interruptedBeforeSave && signal?.aborted) {
    markInterrupted();
    await save();
  }
}

export function classifyPlaywrightReport(report, expected, commandResult) {
  const reasons = [];
  const { exitCode, startedAt, finishedAt, status, timedOut, interrupted, captureError, cleanupError } = commandResult ?? {};
  if (status !== 'passed' || exitCode !== 0 || timedOut !== false || interrupted !== false ||
      captureError !== undefined || cleanupError !== undefined) reasons.push('Command did not complete successfully');
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  const validCommandInterval = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  if (!validCommandInterval) reasons.push('Command timestamps are invalid or out of order');
  const reportTime = Date.parse(report?.stats?.startTime);
  const duration = report?.stats?.duration;
  const validReportInterval = Number.isFinite(reportTime) && Number.isFinite(duration) && duration > 0;
  if (!validReportInterval || !validCommandInterval || reportTime < start - 2000 ||
      reportTime + duration > end + 2000) reasons.push('Report interval is invalid or outside this invocation');
  const tests = [];
  const visit = suites => {
    if (suites === undefined) return;
    if (!Array.isArray(suites)) { reasons.push('Malformed suite records'); return; }
    for (const suite of suites) {
      if (suite?.specs !== undefined && !Array.isArray(suite.specs)) reasons.push('Malformed case records');
      for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
        if (!Array.isArray(spec?.tests)) { reasons.push('Missing test records'); continue; }
        tests.push(...spec.tests.map(test => ({ ...test, specId: spec.id })));
      }
      visit(suite?.suites);
    }
  };
  visit(report?.suites);
  const projects = Object.fromEntries(Object.keys(expected).map(name => [name, { executed: 0, passed: 0 }]));
  const identities = new Set();
  for (const test of tests) {
    const identity = `${test.projectName}:${test.specId}`;
    if (typeof test.specId !== 'string' || !test.specId || identities.has(identity)) reasons.push('Missing or duplicate project/case identity');
    identities.add(identity);
    const project = projects[test.projectName];
    if (!project) { reasons.push(`Unexpected project ${test.projectName}`); continue; }
    const results = Array.isArray(test.results) ? test.results : [];
    if (results.some(result => result?.status !== 'skipped')) project.executed++;
    const result = results[0];
    const resultTime = Date.parse(result?.startTime);
    const validResultInterval = Number.isFinite(resultTime) && Number.isFinite(result?.duration) && result.duration >= 0;
    const intervalInStage = validReportInterval && validResultInterval && resultTime >= reportTime - 2000 &&
      resultTime + result.duration <= reportTime + duration + 2000;
    const intervalInCommand = validCommandInterval && validResultInterval && resultTime >= start - 2000 &&
      resultTime + result.duration <= end + 2000;
    if (!intervalInStage) reasons.push(`${test.projectName}: case interval is invalid or outside the stage`);
    if (!intervalInCommand) reasons.push(`${test.projectName}: case interval is invalid or outside this invocation`);
    if (test.status === 'expected' && test.expectedStatus === 'passed' && results.length === 1 &&
        result?.status === 'passed' && result.retry === 0 && Array.isArray(result.errors) && !result.errors.length &&
        intervalInStage && intervalInCommand) project.passed++;
    else reasons.push(`${test.projectName}: ${test.status ?? 'unclassified'} or incomplete execution`);
  }
  for (const [name, count] of Object.entries(expected)) {
    if (projects[name].executed !== count || projects[name].passed !== count) reasons.push(`${name}: expected ${count}, executed ${projects[name].executed}, passed ${projects[name].passed}`);
  }
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  if (!report?.stats || report.stats.expected !== total || report.stats.unexpected !== 0 || report.stats.skipped !== 0 || report.stats.flaky !== 0) reasons.push('Summary must contain all expected cases and zero failures, skips or flaky cases');
  if (tests.length !== total) reasons.push(`Expected ${total} case records, found ${tests.length}`);
  if (!Array.isArray(report?.errors) || report.errors.length) reasons.push('Global Playwright errors present or missing');
  const configuration = report?.config;
  if (configuration?.workers !== 1 || configuration?.maxFailures !== 0 || configuration?.shard !== null) reasons.push('Configuration must use one worker, no failure limit and no shard');
  const configuredProjects = Array.isArray(configuration?.projects) ? configuration.projects : [];
  if (configuredProjects.some(project => project?.retries !== 0 || project?.repeatEach !== 1)) reasons.push('Projects must disable retries and execute each case once');
  const configured = configuredProjects.map(project => project?.name).sort();
  if (JSON.stringify(configured) !== JSON.stringify(Object.keys(expected).sort())) reasons.push('Configured projects differ from the accepted desktop scope');
  return { status: reasons.length ? 'failed' : 'passed', projects,
    expectedCases: total, testsExecuted: Object.values(projects).reduce((a, b) => a + b.executed, 0),
    reasons: [...new Set(reasons)] };
}

export async function inspectProductionArtifacts(directory, expectedLicenses) {
  if (!validSHA256(expectedLicenses?.licenseSHA256) || !validSHA256(expectedLicenses?.noticesSHA256)) throw new Error('Expected source license hashes are missing or invalid');
  const index = await readFile(path.join(directory, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  if (!assets.length || assets.some(asset => !/^\/assets\/[a-zA-Z0-9._-]+$/.test(asset))) throw new Error('Production entry must reference local /assets/ files');
  const hashes = {};
  const bundled = (await readdir(path.join(directory, 'assets'), { withFileTypes: true })).map(entry => {
    if (!entry.isFile() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) throw new Error('Production assets must be regular local files');
    return `/assets/${entry.name}`;
  });
  for (const asset of [...new Set([...assets, ...bundled])].sort()) {
    const bytes = await readFile(path.join(directory, asset.slice(1)));
    if (!bytes.length) throw new Error(`Empty asset: ${asset}`);
    if (asset.endsWith('.js') && /__BATTLECITY__|setEditorTile|getEditorTiles|renderScene/.test(bytes.toString('utf8'))) throw new Error(`Test hooks present in production asset: ${asset}`);
    hashes[asset] = sha256(bytes);
  }
  const license = await readFile(path.join(directory, 'LICENSE.txt'));
  const notices = await readFile(path.join(directory, 'THIRD_PARTY_NOTICES.md'));
  if (!license.toString('utf8').includes('GNU GENERAL PUBLIC LICENSE') || !notices.toString('utf8').includes('Arnout Kazemier')) throw new Error('Production licenses or third-party notices missing');
  const licensesSHA256 = { licenseSHA256: sha256(license), noticesSHA256: sha256(notices) };
  if (licensesSHA256.licenseSHA256 !== expectedLicenses.licenseSHA256 ||
      licensesSHA256.noticesSHA256 !== expectedLicenses.noticesSHA256) throw new Error('Production licenses do not match the initial source snapshot');
  return { status: 'passed', scope: 'static production artifacts; no browser execution', referencedAssets: assets,
    assetsSHA256: hashes, testHooksAbsent: true, licensesPresent: true, licensesSHA256, licensesMatchSource: true };
}

export function runtimeEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv, PATH: `${path.dirname(process.execPath)}${path.delimiter}${baseEnv.PATH ?? ''}` };
  // Validation always starts from the test build, irrespective of a caller's previous run.
  delete env.BATTLECITY_PRODUCTION;
  return env;
}

async function sourceSnapshot(runDir, env, signal, phase) {
  const git = async (name, args) => {
    const result = await command(runDir, env, `${phase}-git-${name}`, 'git', ['-C', repoRoot, ...args], 10_000, { signal, quiet: true });
    if (result.status !== 'passed') throw Object.assign(new Error(result.reason || result.tail || `Git source snapshot did not complete; see ${result.log}`), { code: result.interrupted ? 'ABORT_ERR' : undefined });
    if (result.stdoutTruncated) throw new Error(`Git source output exceeded the in-memory bound; see ${result.stdoutLog}`);
    return result.stdout;
  };
  const commit = (await git('commit', ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Git returned an invalid commit identity');
  const dirtyStatus = (await git('status', ['status', '--porcelain=v1'])).trim();
  const names = [...new Set((await git('files', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'web', 'LICENSE'])).split('\0').filter(Boolean))].sort();
  if (!names.some(name => name.startsWith('web/'))) throw new Error('No git-listed web source files');
  const root = await realpath(repoRoot);
  const files = [];
  for (const relative of names) {
    throwIfInterrupted(signal);
    const filename = path.join(repoRoot, relative);
    let stat;
    try { stat = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) { files.push({ path: relative, kind: 'deleted' }); continue; }
    const resolved = await realpath(filename);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Source symlink escapes repository: ${relative}`);
    if (stat.isSymbolicLink()) files.push({ path: relative, kind: 'symlink', target: await readlink(filename) });
    else if (stat.isFile()) files.push({ path: relative, kind: 'file', sha256: sha256(await readFile(filename)) });
    else throw new Error(`Unsupported source entry: ${relative}`);
  }
  throwIfInterrupted(signal);
  const licenseSHA256 = files.find(file => file.path === 'LICENSE')?.sha256;
  const noticesSHA256 = files.find(file => file.path === 'web/THIRD_PARTY_NOTICES.md')?.sha256;
  if (!validSHA256(licenseSHA256) || !validSHA256(noticesSHA256)) throw new Error('Source license files are missing or are not regular files');
  return { schemaVersion: 2, path: repoRoot, commit, dirty: !!dirtyStatus, dirtyStatus, licenseSHA256, noticesSHA256,
    workingTreeFingerprint: fingerprintEntries(files), fingerprintScope: 'git-listed web files and root LICENSE', sourceFileCount: files.length, files };
}

async function checkDependencies() {
  const pkg = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(webRoot, 'package-lock.json'), 'utf8'));
  const packages = {};
  const mismatches = [];
  for (const [name, pinned] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    let installed = null;
    try { installed = JSON.parse(await readFile(path.join(webRoot, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
    packages[name] = { pinned, locked, installed };
    if (pinned !== locked || pinned !== installed) mismatches.push(name);
  }
  const rootLock = lock.packages?.[''];
  for (const field of ['dependencies', 'devDependencies']) {
    if (JSON.stringify(Object.entries(pkg[field] ?? {}).sort()) !== JSON.stringify(Object.entries(rootLock?.[field] ?? {}).sort())) mismatches.push(`lockfile ${field}`);
  }
  return { status: mismatches.length ? 'blocked' : 'passed', packages, mismatches,
    packageLockSHA256: sha256(await readFile(path.join(webRoot, 'package-lock.json'))),
    reason: mismatches.length ? 'Pinned dependencies differ or are missing; use --install in a normal terminal' : 'Pinned direct dependencies and lockfile match installed versions' };
}

function environmentalError(text) {
  return /EPERM|EACCES|operation not permitted|permission denied|EADDRINUSE|cannot listen|Host system is missing dependencies|error while loading shared libraries|Executable doesn't exist|browserType\.launch: Timeout|sudo:.*(?:terminal|password)|no tty present|ENOTFOUND|network is unreachable/i.test(text);
}

async function probePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve({ status: 'blocked', host: '127.0.0.1', port: 4173, code: error.code, reason: error.message }));
    server.listen(4173, '127.0.0.1', () => server.close(() => resolve({ status: 'passed', host: '127.0.0.1', port: 4173 })));
  });
}

async function probeBrowser(name) {
  let browser;
  try {
    const playwright = await import('@playwright/test');
    browser = await playwright[name].launch({ headless: true, timeout: 30_000 });
    const result = { status: 'passed', name, version: browser.version(), configuredExecutable: playwright[name].executablePath() };
    await browser.close();
    return result;
  } catch (error) {
    try { await browser?.close(); } catch {}
    return { status: 'blocked', name, reason: error.message, stack: error.stack };
  }
}

async function ownedDescendants(pid) {
  const descendants = [];
  try {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
    for (const child of children) descendants.push(child, ...await ownedDescendants(child));
  } catch {}
  return descendants;
}

async function processRecord(pid, strict = false) {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) return undefined;
    return { pid, identity: fields[19], parent: Number(fields[1]), state: fields[0], group: Number(fields[2]), session: Number(fields[3]) };
  } catch (error) {
    if (strict && !['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    return undefined;
  }
}

async function groupMembers(group) {
  const members = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const record = await processRecord(Number(entry), true);
    if (record?.group === group) members.push(record);
  }
  return members;
}

// Scanning the group only determines whether it has live processes. New
// members are never substituted for saved birth identities as ownership proof.
export async function cleanupExitedGroup(pid, owner, targets = [], {
  readMembers = groupMembers, readProcess = processRecord, sendSignal = (target, signal) => process.kill(target, signal),
} = {}) {
  try { sendSignal(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  if (process.platform === 'linux') {
    const members = await readMembers(pid);
    if (members.length && members.every(member => ['Z', 'X'].includes(member.state))) return;
  }
  await signalOwnedGroup(await owner, targets, 'SIGKILL', { readProcess, sendSignal });
}

// Stop each proven parent before reading its children. Once stopped, it cannot
// fork between enumeration and leaf-to-root termination after the TERM grace.
export async function stopAndKillOwnedTargets(targets, {
  readProcess = processRecord,
  readChildren = async pid => {
    try { return (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
  },
  sendSignal = (pid, signal) => process.kill(pid, signal),
  now = Date.now, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + 250;
  const visited = new Set();
  const owned = new Map(targets.filter(target => target.identity).map(target => [target.pid, target]));
  const postorder = [];
  const matches = (saved, current) => current?.pid === saved.pid && current.identity === saved.identity;
  const signal = (pid, value) => { try { sendSignal(pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const visit = async saved => {
    if (visited.has(saved.pid) || !saved.identity) return;
    visited.add(saved.pid);
    let current = await readProcess(saved.pid);
    if (!matches(saved, current) || ['Z', 'X'].includes(current.state)) return;
    signal(saved.pid, 'SIGSTOP');
    while (matches(saved, current) && !['T', 't', 'Z', 'X'].includes(current.state)) {
      if (now() >= deadline) throw new Error(`Owned process ${saved.pid} did not stop before cleanup deadline`);
      await wait(5);
      current = await readProcess(saved.pid);
    }
    if (!matches(saved, current) || ['Z', 'X'].includes(current.state)) return;
    const children = await readChildren(saved.pid);
    current = await readProcess(saved.pid);
    if (!matches(saved, current) || ['Z', 'X'].includes(current.state)) return;
    if (!['T', 't'].includes(current.state)) throw new Error(`Owned process ${saved.pid} resumed during cleanup`);
    for (const pid of children) {
      const child = await readProcess(pid);
      if (child?.parent !== saved.pid || !child.identity) continue;
      owned.set(pid, child);
      await visit(child);
    }
    postorder.push(saved);
  };
  let problem;
  try { for (const target of [...targets].reverse()) await visit(target); }
  catch (error) { problem = error; }
  // Also release any stopped process if enumeration failed. Every signal is
  // guarded again by its saved birth identity, including discovered children.
  const ordered = [...postorder, ...[...owned.values()].reverse()];
  const killed = new Set();
  for (const target of ordered) {
    if (killed.has(target.pid)) continue;
    killed.add(target.pid);
    try {
      if (matches(target, await readProcess(target.pid))) signal(target.pid, 'SIGKILL');
    } catch (error) { problem ??= error; }
  }
  if (problem) throw problem;
}

async function terminateOwnedTargets(targets, signal) {
  for (const target of targets) {
    if (process.platform === 'linux' && (!target.identity || (await processRecord(target.pid))?.identity !== target.identity)) continue;
    try { process.kill(target.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export async function signalOwnedGroup(owner, targets, signal, {
  readProcess = processRecord, sendSignal = (pid, value) => process.kill(pid, value),
} = {}) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.identity ?? '') ||
      owner.group !== owner.pid || owner.session !== owner.pid) throw new Error('Original isolated process-group identity is unavailable');
  const matches = record => record?.group === owner.group && record.session === owner.session;
  const leader = await readProcess(owner.pid);
  if (leader && (leader.pid !== owner.pid || leader.identity !== owner.identity || !matches(leader))) {
    throw new Error('Original process-group leader identity changed; refusing group signal');
  }
  if (!leader) {
    let anchored = false;
    for (const target of targets) {
      if (!target.identity || !matches(target)) continue;
      const current = await readProcess(target.pid);
      if (current?.pid === target.pid && current.identity === target.identity && matches(current)) { anchored = true; break; }
    }
    if (!anchored) {
      // A vanished group needs no signal. An existing group without a known
      // surviving member cannot be identified safely after its leader exits.
      try { sendSignal(-owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      throw new Error('Original process-group ownership cannot be proven after leader exit');
    }
  }
  try { sendSignal(-owner.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function terminateOwnedChild(child, isolatedGroup, signal, owner) {
  if (!child?.pid) return;
  const verifiedLinuxGroup = isolatedGroup && process.platform === 'linux';
  if (process.platform === 'linux') {
    if (!owner) throw new Error('Spawn-time process identity is unavailable; refusing group cleanup');
    const leader = await processRecord(child.pid);
    if (leader && leader.identity !== owner.identity) throw new Error('Command PID was reused; refusing cleanup');
  }
  const descendants = await ownedDescendants(child.pid);
  const targets = await Promise.all([...descendants.reverse(), child.pid].map(async pid =>
    process.platform === 'linux' && pid === child.pid ? owner : await processRecord(pid) ?? { pid }));
  if (process.platform === 'linux') {
    const leader = await processRecord(child.pid);
    if (leader && leader.identity !== owner.identity) throw new Error('Command PID was reused during descendant discovery; refusing cleanup');
  }
  if (isolatedGroup) {
    // Kill the verified group before its leader or children can fork again.
    if (verifiedLinuxGroup) await signalOwnedGroup(owner, targets, signal);
    else {
      // Other POSIX hosts retain the existing ChildProcess-owned group cleanup;
      // they do not expose Linux /proc identities.
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (!isolatedGroup && process.platform === 'linux' && signal === 'SIGKILL') await stopAndKillOwnedTargets(targets);
  else await terminateOwnedTargets(targets, signal);
  return targets;
}

export function createCommandCleanup(terminate, killTargets, foreground) {
  let cleanup;
  let immediate = !foreground;
  let releaseGrace;
  return (forceKill = false) => {
    if (forceKill) { immediate = true; releaseGrace?.(); }
    cleanup ??= Promise.resolve().then(async () => {
      const signal = immediate ? 'SIGKILL' : 'SIGTERM';
      const targets = await terminate(signal);
      if (signal === 'SIGKILL') return;
      if (!immediate) await new Promise(resolve => {
        const timer = setTimeout(resolve, 250);
        releaseGrace = () => { clearTimeout(timer); resolve(); };
      });
      await killTargets(targets ?? [], 'SIGKILL');
    });
    return cleanup;
  };
}

const stdoutLimit = 262144;
const tailLimit = 65536;
const utf8Tail = (bytes, limit = bytes.length) => {
  bytes = bytes.subarray(Math.max(0, bytes.length - limit));
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const text = bytes.subarray(start).toString('utf8');
  // Invalid original bytes may decode to larger replacement characters. The
  // returned decoded text is bounded too; raw files always keep original bytes.
  const encoded = Buffer.from(text);
  return encoded.length > limit ? utf8Tail(encoded, limit) : text;
};

export function createLogReader(filename, limit, emit = () => {}) {
  let handle;
  let buffer;
  let offset = 0;
  let tail = Buffer.alloc(0);
  const decoder = new StringDecoder('utf8');
  return {
    get bytes() { return offset; },
    get text() { return utf8Tail(tail, limit); },
    async read() {
      handle ??= await open(filename, 'r');
      const end = (await handle.stat()).size;
      if (end < offset) throw new Error('Command output log was truncated during capture');
      if (end === offset) return;
      buffer ??= Buffer.allocUnsafe(65536);
      while (offset < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!bytesRead) throw new Error('Command output log ended before its captured size');
        const chunk = buffer.subarray(0, bytesRead);
        offset += bytesRead;
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > limit) tail = Buffer.from(tail.subarray(tail.length - limit));
        const text = decoder.write(chunk);
        if (text) emit(text);
      }
    },
    async close() {
      try { const text = decoder.end(); if (text) emit(text); }
      finally { await handle?.close(); }
    },
  };
}

async function combineLogs(logPath, stdoutPath, stderrPath, stdoutBytes, stderrBytes, metadata) {
  async function* contents() {
    yield `STDOUT (${path.basename(stdoutPath)})\n`;
    if (stdoutBytes) yield* createReadStream(stdoutPath, { start: 0, end: stdoutBytes - 1 });
    yield `\nSTDERR (${path.basename(stderrPath)})\n`;
    if (stderrBytes) yield* createReadStream(stderrPath, { start: 0, end: stderrBytes - 1 });
    yield `\nRUNNER\n${metadata}\n`;
  }
  await pipeline(Readable.from(contents()), createWriteStream(logPath));
}

export function assertCommandCleanup(result) {
  if (result.cleanupError) throw Object.assign(new Error(`Command cleanup failed: ${result.cleanupError}`), { code: 'CLEANUP_FAILED' });
}

export async function command(runDir, env, name, program, args, timeoutMs = 180_000, { signal, foreground = false, quiet = false } = {}) {
  throwIfInterrupted(signal);
  const logPath = path.join(runDir, `${name}.log`);
  const stdoutPath = path.join(runDir, `${name}.stdout.log`);
  const stderrPath = path.join(runDir, `${name}.stderr.log`);
  const stdoutFd = openSync(stdoutPath, 'w');
  let stderrFd;
  try { stderrFd = openSync(stderrPath, 'w'); } catch (error) { closeSync(stdoutFd); throw error; }
  const startedAt = new Date().toISOString();
  if (!quiet) console.log(`[${name}] ${program} ${args.join(' ')}`);
  return new Promise(resolve => {
    let cleanupError = '';
    let child;
    let timer;
    let timedOut = false;
    let interrupted = false;
    let cleanup;
    let spawnIdentity;
    let settled = false;
    let captureError;
    let polling = Promise.resolve();
    const stdoutReader = createLogReader(stdoutPath, stdoutLimit, quiet ? undefined : value => process.stdout.write(value));
    const stderrReader = createLogReader(stderrPath, tailLimit, quiet ? undefined : value => process.stderr.write(value));
    const display = async () => {
      const results = await Promise.allSettled([stdoutReader.read(), stderrReader.read()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const displayTimer = quiet ? undefined : setInterval(() => { polling = polling.then(display).catch(error => { captureError ??= error.message; }); }, 250);
    const isolatedGroup = process.platform !== 'win32' && !foreground;
    const requestCleanup = createCommandCleanup(async value =>
      terminateOwnedChild(child, isolatedGroup, value, await spawnIdentity),
    foreground && process.platform === 'linux' ? stopAndKillOwnedTargets : terminateOwnedTargets, foreground);
    const beginCleanup = forceKill => {
      const requested = requestCleanup(forceKill);
      if (!cleanup) {
        cleanup = requested.catch(error => { cleanupError = error.message ?? String(error); });
        // Missing ownership proof is an explicit cleanup error, not an endless
        // wait for a process that could not safely be signalled.
        void cleanup.then(() => { if (cleanupError && !settled) void finish(null); });
      }
    };
    const stop = () => {
      if (interrupted || settled) return;
      interrupted = true;
      beginCleanup(false);
    };
    const finish = async (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timer = undefined;
      clearInterval(displayTimer);
      signal?.removeEventListener('abort', stop);
      await cleanup;
      if (!cleanup && isolatedGroup && child?.pid) {
        try { await cleanupExitedGroup(child.pid, spawnIdentity); }
        catch (problem) { cleanupError = problem.message ?? String(problem); }
      }
      closeSync(stdoutFd);
      closeSync(stderrFd);
      try {
        await polling;
        await display();
      } catch (problem) { captureError ??= problem.message; }
      for (const result of await Promise.allSettled([stdoutReader.close(), stderrReader.close()])) {
        if (result.status === 'rejected') captureError ??= result.reason.message;
      }
      const stdout = stdoutReader.text;
      const stderr = stderrReader.text;
      const reason = interrupted ? `Interrupted by ${signal?.reason}` : error?.message ||
        (timedOut ? `Command exceeded ${timeoutMs} ms` : captureError ? `Output capture failed: ${captureError}` :
          exitCode !== 0 ? `Command exited with code ${exitCode ?? 'unknown'}` : undefined);
      const metadata = [reason, cleanupError ? `Cleanup: ${cleanupError}` : undefined].filter(Boolean).join('\n');
      try { await combineLogs(logPath, stdoutPath, stderrPath, stdoutReader.bytes, stderrReader.bytes, metadata); }
      catch (problem) { captureError = problem.message; }
      const status = error || interrupted ? 'blocked' : exitCode === 0 && !timedOut && !captureError && !cleanupError ? 'passed' : 'failed';
      resolve({ status, command: [program, ...args], startedAt, finishedAt: new Date().toISOString(),
        exitCode, log: path.basename(logPath), timedOut, interrupted,
        stdoutLog: path.basename(stdoutPath), stderrLog: path.basename(stderrPath),
        stdoutBytes: stdoutReader.bytes, stderrBytes: stderrReader.bytes,
        ...(reason ? { reason } : {}), ...(captureError ? { captureError } : {}), ...(cleanupError ? { cleanupError } : {}),
        tail: utf8Tail(Buffer.from(`${stdout}\n${stderr}\n${metadata}`).subarray(-tailLimit)).trim(), stdout, stdoutTruncated: stdoutReader.bytes > stdoutLimit });
    };
    // Ordinary file descriptors preserve Node output even when a host's pipe
    // implementation drops console/stream writes. Separate streams retain the
    // original bytes; the combined log is a convenience, not a timeline.
    try { child = spawn(program, args, { cwd: webRoot, env, detached: isolatedGroup, stdio: [foreground ? 'inherit' : 'ignore', stdoutFd, stderrFd] }); }
    catch (error) { finish(null, error); return; }
    // This identity never changes when cleanup runs; a reused numeric PID is
    // not evidence that a later process belongs to this invocation.
    spawnIdentity = processRecord(child.pid).then(record => record && Object.freeze(record));
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code));
    timer = setTimeout(() => { if (!settled) { timedOut = true; beginCleanup(true); } }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

const publicStep = result => { const { stdout, tail, ...step } = result; return step; };
const blocked = reason => ({ status: 'blocked', testsExecuted: 0, reason });

async function main(args) {
  if (args.includes('--help')) { console.log('npm run validate:desktop -- [--install] [--preflight-only]\nDefault: no installs; save checks and browser acceptance in test-results/acceptance/.\n--install: npm ci only for mismatches; install Chromium/WebKit with host dependencies.'); return 0; }
  if (args.some(arg => !['--install', '--preflight-only'].includes(arg))) throw new Error('Unknown option; use --help');
  const env = runtimeEnvironment();
  const runDir = path.join(webRoot, 'test-results', 'acceptance', `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const report = { schemaVersion: 2, status: 'running', browserAcceptance: 'unverified', startedAt: new Date().toISOString(), scope: args.includes('--preflight-only') ? 'environment preflight only; no browser acceptance' : 'desktop Chromium/WebKit execution acceptance',
    runtime: { node: process.version, executable: process.execPath, platform: process.platform, architecture: process.arch,
      browserCache: env.PLAYWRIGHT_BROWSERS_PATH ?? 'Playwright default', libraryPath: env.LD_LIBRARY_PATH ?? '',
      rendering: Object.fromEntries(['LP_NUM_THREADS', 'WEBKIT_SKIA_ENABLE_CPU_RENDERING', 'WEBKIT_SKIA_CPU_PAINTING_THREADS']
        .filter(key => env[key] !== undefined).map(key => [key, env[key]])) },
    installRequested: args.includes('--install'), published: false, brandedEdgeSafari: 'unverified', checks: {} };
  const controller = new AbortController();
  const interrupt = signal => {
    report.interruption = { signal, at: new Date().toISOString() };
    controller.abort(signal);
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const save = async () => writeFile(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const runCommand = async (name, program, args, timeoutMs, options = {}) => {
    const result = await command(runDir, env, name, program, args, timeoutMs, { ...options, signal: controller.signal });
    if (result.interrupted) {
      report.checks.interruption = publicStep(result);
      throw Object.assign(new Error(result.reason), { code: 'ABORT_ERR' });
    }
    if (result.cleanupError) {
      report.checks[name] = publicStep(result);
      assertCommandCleanup(result);
    }
    return result;
  };
  try {
    report.repository = await sourceSnapshot(runDir, env, controller.signal, 'initial');
    await writeFile(path.join(runDir, 'source-manifest.json'), `${JSON.stringify(report.repository, null, 2)}\n`);
    await save();
    report.checks.node = Number(process.versions.node.split('.')[0]) === 24 ? { status: 'passed', version: process.version } : blocked('Node 24 required; select Node 24 in the normal terminal');
    report.checks.dependencies = await checkDependencies();
    if (args.includes('--install') && report.checks.node.status === 'passed') {
      if (report.checks.dependencies.status !== 'passed') {
        const install = await runCommand('npm-ci', 'npm', ['ci'], 600_000, { foreground: true });
        report.checks.installDependencies = publicStep(install);
        if (install.status !== 'passed' && environmentalError(install.tail)) report.checks.installDependencies.status = 'blocked';
        report.checks.dependencies = await checkDependencies();
      }
      if (report.checks.dependencies.status === 'passed') {
        const install = await runCommand('install-browsers', process.execPath, ['node_modules/@playwright/test/cli.js', 'install', '--with-deps', 'chromium', 'webkit'], 600_000, { foreground: true });
        report.checks.installBrowsers = publicStep(install);
        if (install.status !== 'passed' && environmentalError(install.tail)) report.checks.installBrowsers = { ...report.checks.installBrowsers, status: 'blocked', reason: 'Dependency installation needs an available network or normal terminal privileges; inspect the log' };
      }
    }
    report.checks.port = await probePort();
    for (const name of ['chromium', 'webkit']) {
      if (report.checks.node.status !== 'passed' || report.checks.dependencies.status !== 'passed') { report.checks[name] = blocked('Node or pinned dependencies unavailable'); continue; }
      const result = await runCommand(`preflight-${name}`, process.execPath, [scriptPath, '--probe-browser', name], 40_000);
      try {
        const observation = JSON.parse(result.stdout.trim());
        report.checks[name] = { ...observation, status: observation.status === 'passed' && result.status === 'passed' && !result.timedOut ? 'passed' : 'blocked', log: result.log, timeoutMs: 30_000,
          ...(result.status !== 'passed' && observation.status === 'passed' ? { reason: 'Browser probe did not exit successfully', commandResult: publicStep(result) } : {}) };
      }
      catch (error) {
        report.checks[name] = { ...publicStep(result), status: 'blocked', parserError: error.message,
          reason: `Browser probe JSON could not be parsed (${error.message}); exit=${result.exitCode ?? 'unknown'}, timedOut=${result.timedOut}. ${result.reason || result.tail.trim().slice(-2048) || 'No captured output'}. See ${result.log}` };
      }
      await save();
    }
    const canBuild = report.checks.node.status === 'passed' && report.checks.dependencies.status === 'passed';
    const canBrowse = canBuild && ['port', 'chromium', 'webkit'].every(name => report.checks[name].status === 'passed');
    if (!args.includes('--preflight-only')) {
      for (const [name, npmScript] of [['typecheck', 'typecheck'], ['runnerTests', 'test:acceptance'], ['unit', 'test']]) {
        report.checks[name] = canBuild ? publicStep(await runCommand(name, 'npm', ['run', npmScript])) : blocked('Build dependencies unavailable');
        await save();
      }
      const browserSuite = async (kind, npmScript) => {
        if (!canBrowse) return blocked('Environment preflight blocked; no game cases executed');
        const filename = path.join(webRoot, 'test-results', `${kind}.json`);
        try { await unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Both engines run serially in one worker slot. Keep stage headroom
        // beyond their individual case budgets for server startup, isolated
        // fault-injection browsers, reporting and cleanup.
        const result = await runCommand(kind, 'npm', ['run', npmScript], kind === 'e2e' ? 6_000_000 : 1_500_000);
        let verdict;
        try { verdict = classifyPlaywrightReport(JSON.parse(await readFile(filename, 'utf8')), expectedCases[kind], result); }
        catch (error) { verdict = { status: 'failed', testsExecuted: 0, reasons: [`Actual report unavailable: ${error.message}`] }; }
        if (verdict.testsExecuted === 0 && (result.status === 'blocked' || environmentalError(result.tail))) verdict = { ...verdict, status: 'blocked', reason: 'Environment prevented case execution; inspect the command log' };
        const destination = path.join(runDir, kind);
        await mkdir(destination, { recursive: true });
        for (const [from, to] of [[filename, `${kind}.json`], [path.join(webRoot, 'test-results', kind), 'results'], [path.join(webRoot, 'playwright-report', kind), 'html']]) {
          if (await exists(from)) await cp(from, path.join(destination, to), { recursive: true });
        }
        await writeFile(path.join(destination, 'source-binding.json'), `${JSON.stringify({ schemaVersion: 2, sourceFingerprint: report.repository.workingTreeFingerprint, commit: report.repository.commit, dirty: report.repository.dirty, licenseSHA256: report.repository.licenseSHA256, noticesSHA256: report.repository.noticesSHA256, startedAt: result.startedAt, finishedAt: result.finishedAt, reportSHA256: await exists(filename) ? sha256(await readFile(filename)) : null }, null, 2)}\n`);
        return { ...publicStep(result), ...verdict, artifacts: kind };
      };
      const staticReady = ['typecheck', 'runnerTests', 'unit'].every(name => report.checks[name].status === 'passed');
      report.checks.desktopE2E = staticReady ? await browserSuite('e2e', 'test:e2e') : blocked('Fix preceding static checks before browser acceptance');
      await save();
      report.checks.productionBuild = canBuild ? publicStep(await runCommand('production-build', 'npm', ['run', 'bundle'])) : blocked('Build dependencies unavailable');
      try { report.checks.productionArtifacts = report.checks.productionBuild.status === 'passed' ? await inspectProductionArtifacts(path.join(webRoot, 'dist'), report.repository) : blocked('Production build unavailable'); }
      catch (error) { report.checks.productionArtifacts = { status: 'failed', reason: error.message }; }
      await save();
      report.checks.productionSmoke = staticReady && report.checks.productionArtifacts.status === 'passed' ? await browserSuite('production', 'test:deploy') : blocked('Fix static checks and production artifacts before production smoke');
    }
    const finalSource = await bindFinalSource(report.repository, () => sourceSnapshot(runDir, env, controller.signal, 'final'), controller.signal);
    report.checks.sourceBinding = finalSource.binding;
    report.finalSourceFingerprint = finalSource.fingerprint;
    const checks = Object.values(report.checks);
    report.status = checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'blocked') ? 'blocked' : 'passed';
    report.browserAcceptance = !args.includes('--preflight-only') && report.status === 'passed' ? 'passed' : 'unverified';
  } catch (error) {
    report.status = error.code !== 'CLEANUP_FAILED' && (error.code === 'ABORT_ERR' || environmentalError(error.message)) ? 'blocked' : 'failed';
    report.browserAcceptance = 'unverified';
    report.error = { message: error.message, stack: error.stack };
  }
  report.finishedAt = new Date().toISOString();
  await saveFinalReport(report, save, controller.signal);
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  console.log(`Desktop validation ${report.status}; browser acceptance ${report.browserAcceptance}.\nReport: ${path.join(runDir, 'report.json')}`);
  return report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--probe-browser' && ['chromium', 'webkit'].includes(process.argv[3]) && process.argv.length === 4) {
    const result = await probeBrowser(process.argv[3]);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'passed' ? 0 : 2;
  } else {
    try { process.exitCode = await main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
