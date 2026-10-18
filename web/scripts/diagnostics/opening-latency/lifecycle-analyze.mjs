import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashDirectory, sha256 } from './common.mjs';
import { LIFECYCLE_EVENTS as K, LIFECYCLE_COLUMNS, LIFECYCLE_REASONS, LIFECYCLE_MESSAGE_TYPES } from './lifecycle-instrument.mjs';
import { pcmWindowFeatures, pcmShotWindowFeatures, restorePcmSnapshot } from '../../../tests/browser/pcm-window.ts';

const expectedSequence = ['test', 'production'].flatMap((mode, block) => [
  { engine: 'chromium', diagnostic: true }, { engine: 'webkit', diagnostic: false },
  { engine: 'webkit', diagnostic: true }, { engine: 'webkit', diagnostic: true },
].map((entry, index) => ({ number: block * 4 + index + 1, mode, ...entry,
  group: `${mode}-${entry.diagnostic ? 'diagnostic' : 'baseline'}` })));
const reasonName = value => Object.entries(LIFECYCLE_REASONS).find(([, code]) => code === value)?.[0] ?? 'unknown';
const sameIdentity = (row, message) => row.generation === message.generation && row.sequence === message.sequence;
const numericEqual = (left, right) => typeof left === 'number' && typeof right === 'number'
  ? Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9 : left === right;
function sameValue(left, right) {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return numericEqual(left, right);
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Compare frame-labelled tap data, never the time its packet reached the page. */
function tapQuantum(snapshots, frame, length) {
  const matches = [];
  for (const entry of snapshots) for (const packet of restorePcmSnapshot(entry.snapshot).packets) {
    let offset = 0;
    for (let index = 0; index < packet.frames.length; index++) {
      if (packet.frames[index] === frame && packet.lengths[index] === length) {
        const samples = [...packet.samples.subarray(offset, offset + length)];
        if (samples.length !== length || samples.some(value => !Number.isFinite(value))) throw new Error('Malformed matching tap quantum');
        matches.push(samples);
      }
      offset += packet.lengths[index];
    }
  }
  if (!matches.length) return null;
  if (matches.some(values => !sameValue(values, matches[0]))) throw new Error('Repeated raw snapshots disagree at the same tap frame');
  return { frame, length, peak: Math.max(...matches[0].map(Math.abs)), copies: matches.length };
}

/** Receiver facts are scoped to a message and cue's original identity. Missing
 * or inconsistent evidence is never promoted to a non-reproduction result. */
export function analyzeLifecycleTimeline(record) {
  if (!record.diagnostic) return { status: 'baseline-without-receiver-trace', diagnosticOnly: true };
  const trace = record.timeline, issues = [];
  const fail = message => issues.push(message);
  if (!trace) return { status: 'incomplete', issues: ['Missing lifecycle timeline'] };
  if (trace.error) fail('Harvest failed: ' + trace.error);
  if (trace.schemaVersion !== 1 || trace.worklet?.schemaVersion !== 1) fail('Unsupported diagnostic schema');
  if (!Number.isInteger(trace.graph) || trace.graph <= 0 || trace.graphs !== 1) fail('Audio graph identity is missing or changed');
  if (trace.main?.dropped !== 0 || trace.worklet?.dropped !== 0) fail('Diagnostic rows are missing or overflowed');
  const rawEvents = trace.main?.events, packed = trace.worklet?.rows ?? [], rows = [];
  const events = Array.isArray(rawEvents) ? rawEvents.filter(event => event && typeof event === 'object') : [];
  if (!Array.isArray(rawEvents) || !events.length) fail('Missing main-thread event records');
  if (Array.isArray(rawEvents) && events.length !== rawEvents.length) fail('Malformed main-thread event records');
  if (!Array.isArray(packed) || !packed.length) fail('Missing Worklet event records');
  const rate = trace.worklet?.rate;
  if (!Number.isInteger(rate) || rate <= 0 || rate !== trace.rate) fail('Worklet/context sample rate mismatch');
  if (!Number.isInteger(trace.worklet?.frame) || trace.worklet.frame < 0) fail('Invalid Worklet dump frame');
  if (trace.worklet?.stride !== LIFECYCLE_COLUMNS.length || !Array.isArray(packed) || packed.length % LIFECYCLE_COLUMNS.length) fail('Malformed receiver rows');
  if (Array.isArray(packed)) for (let index = 0; index + LIFECYCLE_COLUMNS.length <= packed.length; index += LIFECYCLE_COLUMNS.length) {
    const row = Object.fromEntries(LIFECYCLE_COLUMNS.map((name, column) => [name, packed[index + column]]));
    if (Object.values(row).some(value => !Number.isFinite(value)) || !Object.values(K).includes(row.kind) ||
        !Number.isInteger(row.frame) || row.frame < 0 || !Number.isInteger(row.generation) || row.generation < 0 ||
        !Number.isInteger(row.sequence) || row.sequence < 0 || !Number.isInteger(row.cue) || row.cue < -1 || row.cue >= 28) fail('Invalid receiver identity/frame');
    rows.push(row);
  }
  for (const event of events) {
    if (!Number.isFinite(event.perfBefore) || !Number.isFinite(event.perfAfter) || event.perfAfter < event.perfBefore) fail('Invalid main-thread clock bracket');
    if (event.graph !== null && event.graph !== 0 && event.graph !== trace.graph) fail('Main events refer to another graph');
    if (event.audioAt !== null && (!Number.isFinite(event.audioAt) || event.audioAt < 0)) fail('Invalid main audio coordinate');
  }
  for (const entry of record.snapshots ?? []) if (entry.snapshot.rate !== rate) fail('PCM/receiver sample rate mismatch');
  const anchorEvent = (kind, at, code) => events.findLast(event => event.kind === kind && event.pcmEventAt === at && event.code === code);
  const postAfter = post => events.find(event => event.kind === 'post-after' && sameIdentity(event, post) && event.type === post.type);
  const segments = (anchor, post, receipt, applied) => {
    const after = postAfter(post);
    if (!after || after.perfBefore < post.perfBefore || post.perfBefore < anchor.perfBefore) fail('Missing or unordered main send boundary');
    if (post.graph !== trace.graph || anchor.graph !== trace.graph || !Number.isFinite(post.audioAt)) fail('Send and event graph/clock mismatch');
    if (receipt && applied && applied.frame < receipt.frame) fail('Application precedes receiver receipt');
    return {
      mainMs: { eventToPost: post.perfBefore - anchor.perfBefore,
        postCall: after ? after.perfAfter - post.perfBefore : null },
      audioMs: { eventToPost: Number.isFinite(post.audioAt) ? (post.audioAt - anchor.pcmEventAt) * 1000 : null,
        postToReceipt: receipt ? (receipt.frame / rate - post.audioAt) * 1000 : null,
        receiptToApplied: receipt && applied ? (applied.frame - receipt.frame) / rate * 1000 : null },
    };
  };

  let shot = { outcome: 'unreached' }, focus = { outcome: 'unreached' };
  const shotAt = record.anchors?.shotAt;
  if (Number.isFinite(shotAt) && record.measurements?.shot) {
    const anchor = anchorEvent('key', shotAt, 'KeyJ');
    if (!anchor) fail('Shot event does not match the original PCM key anchor');
    const post = events.find(event => event.kind === 'post-before' && event.type === 'commands' &&
      anchor && event.perfBefore >= anchor.perfBefore && event.commands?.some(command => command.id === 15 && command.start));
    if (!post) shot = { outcome: 'no-shot-command-observed', signature: record.measurements.shot.status };
    else {
      const matching = rows.filter(row => sameIdentity(row, post));
      const receipt = matching.find(row => row.kind === K.receipt && row.value === LIFECYCLE_MESSAGE_TYPES.commands);
      const rejection = matching.find(row => row.kind === K.reject);
      const queued = matching.find(row => row.kind === K.queue && row.cue === 15 && row.value === 1);
      const decision = matching.find(row => row.cue === 15 && [K.execute, K.expired, K.replace, K.clear].includes(row.kind));
      const command = post.commands.find(command => command.id === 15 && command.start);
      if (!receipt) fail('Posted shot lacks a receiver receipt');
      if (!rejection && (!queued || !decision)) fail('Shot lacks its queue or terminal decision');
      if (queued && (!receipt || queued.frame < receipt.frame)) fail('Shot queue lacks an earlier receipt');
      if (decision && (!queued || decision.frame < queued.frame)) fail('Shot decision lacks its original queued identity');
      if (queued && (queued.createdAt !== command.createdAt || queued.sentAt !== post.sentAt)) fail('Queued shot timestamps differ from its original message');
      if (decision && queued && (decision.createdAt !== queued.createdAt || decision.sentAt !== queued.sentAt)) fail('Shot decision timestamps differ from its queued source');
      let outcome = 'receipt-not-observed-before-harvest';
      if (rejection) outcome = 'rejected-' + reasonName(rejection.value);
      else if (decision?.kind === K.expired) outcome = 'receiver-expired-shot';
      else if (decision?.kind === K.execute && decision.value === 1) outcome = record.measurements.shot.status === 'passed'
        ? 'shot-executed-signature-observed' : 'shot-executed-signature-failed';
      else if (decision?.kind === K.replace) outcome = 'queued-shot-replaced';
      else if (decision?.kind === K.clear) outcome = 'queued-shot-cleared-' + reasonName(decision.value);
      else if (queued) outcome = 'queued-without-terminal-decision';
      else if (receipt) outcome = 'received-without-queue-or-rejection';
      shot = { outcome, signature: record.measurements.shot.status, generation: post.generation, sequence: post.sequence,
        receipt, queued, decision, rejection, ...(anchor ? segments(anchor, post, receipt, decision) : {}),
        ageAtDecisionMs: decision ? { fromCreation: (decision.frame / rate - decision.createdAt) * 1000,
          fromSend: (decision.frame / rate - decision.sentAt) * 1000 } : null };
    }
  } else fail('Shot measurement was not reached');

  const blurAt = record.anchors?.blurAt, silence = record.measurements?.focusSilence;
  if (Number.isFinite(blurAt) && silence) {
    const anchor = anchorEvent('blur', blurAt, '');
    if (!anchor) fail('Blur event does not match the original PCM anchor');
    const post = events.find(event => event.kind === 'post-before' && event.type === 'pause' && event.paused && event.reason === 'focus' &&
      anchor && event.perfBefore >= anchor.perfBefore);
    if (!post) focus = { outcome: 'no-focus-pause-command-observed', silence: silence.status };
    else {
      const matching = rows.filter(row => sameIdentity(row, post));
      const receipt = matching.find(row => row.kind === K.receipt && row.value === LIFECYCLE_MESSAGE_TYPES.pause);
      const rejection = matching.find(row => row.kind === K.reject);
      const applied = matching.find(row => row.kind === K.pauseApplied && row.value === 1 && row.extra === 1);
      const output = matching.find(row => row.kind === K.focusOutput);
      if (!receipt) fail('Posted focus pause lacks a receiver receipt');
      if (!rejection && !applied) fail('Received focus pause lacks its application record');
      if (applied && !output) fail('Applied focus pause lacks its first output record');
      if (applied && (!receipt || applied.frame < receipt.frame)) fail('Focus pause application lacks its receipt');
      if (output && (!applied || output.frame < applied.frame || !Number.isInteger(output.extra) || output.extra <= 0)) fail('Invalid first focus-output quantum');
      let tap = null;
      if (output) {
        try { tap = tapQuantum(record.snapshots ?? [], output.frame, output.extra); }
        catch (error) { fail(error.message); }
      }
      const failed = silence.status === 'failed', start = silence.parameters?.start;
      let outcome = 'not-reproduced';
      if (rejection) outcome = 'rejected-' + reasonName(rejection.value);
      else if (!receipt) outcome = 'receipt-not-observed-before-harvest';
      else if (!applied) outcome = 'received-without-focus-application';
      else if (!output) outcome = 'no-focus-output-before-resume-or-harvest';
      else if (output.value !== 0) outcome = 'focus-output-was-not-zero';
      else if (tap && tap.peak !== 0) outcome = 'worklet-tap-same-frame-disagreement';
      else if (failed && receipt.frame / rate > start) outcome = 'receipt-after-silence-window-start';
      else if (failed && applied.frame / rate > start) outcome = 'application-after-silence-window-start';
      else if (failed && output.frame / rate > start) outcome = 'first-zero-quantum-after-silence-window-start';
      else if (failed) outcome = 'silence-failure-not-explained-by-first-output-record';
      focus = { outcome, silence: silence.status, generation: post.generation, sequence: post.sequence,
        receipt, applied, output, rejection, tap, ...(anchor ? segments(anchor, post, receipt, applied) : {}),
        blurToFirstZeroMs: output ? (output.frame / rate - blurAt) * 1000 : null,
        tapComparison: tap ? 'same currentFrame and quantum length' : 'matching quantum unavailable; no output-buffer conclusion' };
      if (outcome === 'not-reproduced' && !silence.value?.features) fail('No verified silence measurement supports non-reproduction');
    }
  } else fail('Focus measurement was not reached');
  return { status: issues.length ? 'incomplete' : 'complete', diagnosticOnly: true, graph: trace.graph, rate,
    issues: [...new Set(issues)], shot, focus,
    limitations: ['Audio-coordinate differences are not wall-clock transport or hardware audible latency.',
      'A first zero Worklet block proves only that block; missing tap coverage or missing events cannot prove a root cause.',
      'The post-Gain PCM tap precedes device output; packet arrival delay and speaker buffering do not change recorded sample frames.'] };
}

export async function analyzeLifecycleArchive(archiveDirectory) {
  const archive = path.resolve(archiveDirectory), read = async name => JSON.parse(await readFile(path.join(archive, name), 'utf8'));
  const [config, manifest, experiment, completion, before, after, results] = await Promise.all([
    'config.json', 'build-manifest.json', 'experiment.json', 'completion.json', 'source-at-start.json', 'source-after.json', 'results.json',
  ].map(read));
  const issues = [], check = (ok, message) => { if (!ok) issues.push(message); };
  check(config.scenario === 'lifecycle' && experiment.diagnostic && experiment.scenario === 'lifecycle', 'Archive is not a lifecycle diagnostic');
  check(sameValue(experiment.sequence, expectedSequence), 'Fixed attempt sequence changed');
  check(experiment.workers === 1 && experiment.retries === 0 && experiment.timeoutMs === 60000, 'Run configuration changed');
  check(results.length === 8 && completion.attempted === 8 && completion.expected === 8, 'Expected exactly eight attempted cases');
  check(before.fingerprint === after.fingerprint && before.commit === after.commit && before.fingerprint === config.sourceFingerprint &&
    before.fingerprint === manifest.sourceFingerprint, 'Source identity changed');
  let verifiedAssets = 0, verifiedWindows = 0;
  for (const [group, build] of Object.entries(manifest.groups)) {
    check(sameValue(await hashDirectory(path.join(archive, 'builds', group)), build.hashes), 'Assets changed: ' + group);
    verifiedAssets += Object.keys(build.hashes).length;
  }
  check(sameValue(await hashDirectory(path.join(archive, 'tools')), manifest.toolHashes), 'Archived diagnostic tools changed');
  for (const file of before.files) check(sha256(await readFile(path.join(archive, 'source', file.path))) === file.sha256, 'Frozen source differs: ' + file.path);
  const observations = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index], filename = path.resolve(archive, result.record);
    if (!filename.startsWith(archive + path.sep)) throw new Error('Attempt record is outside its archive');
    const record = JSON.parse(await readFile(filename, 'utf8'));
    for (const [key, expected] of Object.entries(expectedSequence[index] ?? {})) check(record[key] === expected, `Attempt ${index + 1}: ${key} changed`);
    check(record.sourceFingerprint === before.fingerprint && !!record.browserVersion, `Attempt ${index + 1}: missing source/browser identity`);
    check(!record.cleanupError && !record.traceError && !record.timedOut && !record.timelineError && !record.pageErrors.length && !record.evidenceErrors.length,
      `Attempt ${index + 1}: execution/evidence error`);
    if (record.diagnostic) check(record.harvestAttempted === true, `Attempt ${index + 1}: diagnostic harvest missing`);
    else check(!record.harvestAttempted && !record.timeline, `Attempt ${index + 1}: baseline used a receiver dump`);
    try { await access(path.join(path.dirname(filename), 'trace.zip')); }
    catch { issues.push(`Attempt ${index + 1}: trace.zip missing`); }
    for (const [name, measurement] of Object.entries(record.measurements)) {
      const snapshots = record.snapshots.slice(measurement.firstSnapshot, measurement.firstSnapshot + measurement.snapshotCount);
      if (!snapshots.length) {
        check(measurement.status === 'failed', `Attempt ${index + 1}/${name}: no raw PCM`); continue;
      }
      let finalValue, finalError;
      for (const [position, entry] of snapshots.entries()) {
        check(entry.phase === name && numericEqual(entry.request.start, measurement.parameters.start) && numericEqual(entry.request.end, measurement.parameters.end),
          `Attempt ${index + 1}/${name}: snapshot parameters changed`);
        try {
          const capture = restorePcmSnapshot(entry.snapshot);
          check(capture.rate === experiment.sampleRate, `Attempt ${index + 1}/${name}: sample rate changed`);
          finalValue = measurement.kind === 'shot' ? pcmShotWindowFeatures(measurement.parameters, capture)
            : pcmWindowFeatures(measurement.parameters, capture);
          finalError = undefined;
        } catch (error) { finalError = error; }
        if (position === snapshots.length - 1 && measurement.value) {
          check(!finalError && sameValue(finalValue, measurement.kind === 'window' ? measurement.value.features : measurement.value),
            `Attempt ${index + 1}/${name}: replay differs from measured features`);
        }
        // Failed scans are retained evidence, not silently converted to passing windows.
        if (finalError && position === snapshots.length - 1 && !measurement.value) {
          check(measurement.status === 'failed' && finalError.message === measurement.error?.message,
            `Attempt ${index + 1}/${name}: replay error differs`);
        }
        verifiedWindows++;
      }
    }
    const timeline = analyzeLifecycleTimeline(record);
    if (record.diagnostic) check(timeline.status === 'complete', `Attempt ${index + 1}: incomplete receiver evidence (${timeline.issues?.join('; ')})`);
    const shot = record.measurements.shot?.status ?? 'unreached', focus = record.measurements.focusSilence?.status ?? 'unreached';
    check(shot !== 'unreached' && focus !== 'unreached', `Attempt ${index + 1}: target phase not reached`);
    if (shot === 'failed') check(!!record.measurements.shot.value ||
      (record.measurements.shot.failure?.stage === 'measurement' && record.measurements.shot.error?.message?.startsWith('Player-shot PCM signature was absent throughout')),
    `Attempt ${index + 1}: shot failed without a complete valid signature window`);
    if (focus === 'failed') check(!!record.measurements.focusSilence.value?.features,
      `Attempt ${index + 1}: focus failed without a complete valid PCM window`);
    observations.push({ number: record.number, mode: record.mode, engine: record.engine, diagnostic: record.diagnostic,
      record: result.record, shot, focus, lifecycleCompleted: !!record.lifecycleCompleted, error: record.error, timeline });
  }
  const reproduced = observations.filter(row => row.shot === 'failed' || row.focus === 'failed').map(row => row.number);
  const complete = completion.complete && !issues.length;
  const summary = { diagnostic: true, complete, attempted: observations.length, sourceFingerprint: before.fingerprint,
    result: !complete ? 'incomplete; no non-reproduction claim' : reproduced.length ? 'target failure reproduced' : 'not reproduced in the fixed attempts',
    reproduced, observations, integrity: { verifiedAssets, verifiedWindows, issues },
    productAcceptance: 'unverified; diagnostic observations do not replace desktop acceptance',
    limitations: ['Eight fixed attempts, no retries or replacement attempts; absence of failure is not proof of a fix.',
      'Instrumentation may change scheduling; baseline and diagnostic outcomes cannot establish an instrumentation-free root cause alone.',
      'Main-thread performance.now durations and AudioContext/currentFrame durations remain separate domains.',
      'No hardware output latency or audible-device guarantee is measured.'] };
  await writeFile(path.join(archive, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2)); process.exitCode = complete ? 0 : 1; return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await analyzeLifecycleArchive(process.argv[2]);
