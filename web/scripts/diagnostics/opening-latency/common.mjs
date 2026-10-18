import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const permutations = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'];
export const sequence = Array.from({ length: 24 }, (_, block) => [...permutations[block % 6]]
  .map((group, position) => ({ number: block * 3 + position + 1, block: block + 1, position: position + 1, group }))).flat();
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function sourceSnapshot(root) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'web', 'LICENSE'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(name => name && !name.startsWith('web/scripts/diagnostics/opening-latency/'));
  const files = await Promise.all([...new Set(names)].sort().map(async name => ({ path: name, sha256: sha256(await readFile(path.join(root, name))) })));
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.path + '\0').update(Buffer.from(file.sha256, 'hex')).update('\0');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), fingerprint: digest.digest('hex'), files };
}
export async function hashDirectory(root, relative = '') {
  const result = {};
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashDirectory(root, name));
    else if (entry.isFile()) result[name] = sha256(await readFile(path.join(root, name)));
  }
  return result;
}
export function latencyStats(values) {
  const sorted = values.map(value => value === null ? Infinity : value).sort((a, b) => a - b), n = sorted.length;
  const metric = value => Number.isFinite(value) ? { value } : { value: null, censored: true, lowerBoundMs: 180 };
  return { count: n, median: n ? metric((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2) : null,
    p95: n ? metric(sorted[Math.ceil(n * .95) - 1]) : null, max: n ? metric(sorted.at(-1)) : null };
}

export function analyzeTimeline(record) {
  if (record.group === 'A') return { status: 'baseline-without-extra-trace' };
  const trace = record.timeline, issues = [];
  if (!trace) return { status: 'incomplete', issues: ['Missing timeline'] };
  if (trace.dropped || trace.worklet?.dropped) issues.push('Diagnostic buffer overflow');
  const events = trace.events ?? [], key = events.findLast(event => event.kind === 'key' && event.code === 'Enter');
  if (!key || key.pcmEventAt !== record.keyAt) issues.push('Key anchor does not match original PCM capture');
  const scoped = events.filter(event => key && event.perfBefore >= key.perfBefore);
  const post = scoped.find(event => event.kind === 'post-before' && event.type === 'commands');
  const after = scoped.find(event => event.kind === 'post-after' && event.type === 'commands');
  const end = scoped.find(event => event.kind === 'handler-end' && event.code === 'Enter');
  if (!post || !after || !end) issues.push('Missing key handler or send boundary');
  if (post && after && end && (after.perfBefore < post.perfBefore || end.perfBefore < after.perfBefore)) issues.push('Main events out of order');
  if (scoped.some(event => event.graph !== key.graph)) issues.push('Audio context changed during capture');
  if (scoped.some(event => !Number.isFinite(event.perfBefore) || !Number.isFinite(event.perfAfter) || event.perfAfter < event.perfBefore)) issues.push('Invalid main-thread clock');
  const packed = trace.worklet?.rows ?? [], rows = [];
  if (packed.length % 5) issues.push('Malformed Worklet trace');
  for (let i = 0; i < packed.length; i += 5) rows.push({ kind: packed[i], frame: packed[i + 1], generation: packed[i + 2], sequence: packed[i + 3], detail: packed[i + 4] });
  const matching = rows.filter(row => post && row.generation === post.generation && row.sequence === post.sequence);
  const row = kind => matching.find(event => event.kind === kind);
  const receive = row(2), accepted = row(4), apply = row(5), tick1 = row(6), tick2 = row(7), nonzero = row(8), threshold = row(9);
  if (!receive || !accepted) issues.push('Missing Worklet receive/accept record');
  const rate = trace.worklet?.rate;
  if (rate !== record.measurement?.features.rate) issues.push('Sample rate mismatch');
  const ordered = [receive, accepted, apply, tick1, tick2, nonzero, threshold].filter(Boolean);
  if (ordered.some((event, i) => !Number.isInteger(event.frame) || event.frame < 0 || (i && event.frame < ordered[i - 1].frame))) issues.push('Worklet events out of order');
  if (record.measurement?.features.onset !== null && (!apply || !tick1 || !tick2 || !threshold)) issues.push('Audible PCM lacks required Worklet records');
  if (issues.length) return { status: 'incomplete', issues, rows };
  const ms = (a, b) => a && b ? (b.frame - a.frame) / rate * 1000 : null;
  const onset = record.measurement.features.onset;
  return { status: 'complete', generation: post.generation, sequence: post.sequence,
    mainMs: { keyToPost: post.perfBefore - key.perfBefore, postCall: after.perfAfter - post.perfBefore,
      keyToHandlerEnd: end.perfAfter - key.perfBefore },
    audioMs: { keyToPost: (post.audioAt - record.keyAt) * 1000,
      postToReceive: receive.frame / rate * 1000 - post.audioAt * 1000,
      receiveToApply: ms(receive, apply), applyToTick1: ms(apply, tick1), tick1ToTick2: ms(tick1, tick2),
      receiveToThreshold: ms(receive, threshold), tick2ToThreshold: ms(tick2, threshold),
      thresholdToObserved: threshold && onset !== null ? (onset - threshold.frame / rate) * 1000 : null },
    onsetMs: record.onsetMs, censored: onset === null, rows,
    outputTimestamps: trace.timestamps, outputMappingUsedForVerdict: false };
}
