import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { sequence, hashDirectory, sha256, latencyStats, analyzeTimeline } from './common.mjs';
import { pcmWindowFeatures, restorePcmSnapshot } from '../../../tests/browser/pcm-window.ts';

const archive = path.resolve(process.argv[2]);
const read = async name => JSON.parse(await readFile(path.join(archive, name), 'utf8'));
const [config, manifest, experiment, completion, before, after, results] = await Promise.all([
  'config.json', 'build-manifest.json', 'experiment.json', 'completion.json', 'source-at-start.json', 'source-after.json', 'results.json',
].map(read));
const issues = [], check = (ok, message) => { if (!ok) issues.push(message); };
const equal = (a, b) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-10 : a === b;
check(JSON.stringify(experiment.sequence) === JSON.stringify(sequence), 'Experiment sequence differs');
check(results.length === 72 && completion.attempted === 72, 'Expected 72 attempts');
check(before.fingerprint === after.fingerprint && before.fingerprint === manifest.sourceFingerprint && before.fingerprint === config.sourceFingerprint && before.commit === after.commit, 'Source identity changed');
let verifiedAssets = 0, verifiedWindows = 0;
for (const [group, build] of Object.entries(manifest.groups)) {
  check(JSON.stringify(await hashDirectory(path.join(archive, 'builds', group))) === JSON.stringify(build.hashes), 'Assets changed: ' + group);
  verifiedAssets += Object.keys(build.hashes).length;
}
check(JSON.stringify(await hashDirectory(path.join(archive, 'tools'))) === JSON.stringify(manifest.toolHashes), 'Archived tools changed');
for (const file of before.files) check(sha256(await readFile(path.join(archive, 'source', file.path))) === file.sha256, 'Frozen source differs: ' + file.path);
const records = [];
for (let i = 0; i < results.length; i++) {
  const record = await read(results[i].record); records.push(record);
  for (const field of ['number', 'block', 'position', 'group']) check(record[field] === sequence[i]?.[field], `Sequence mismatch: ${i + 1}/${field}`);
  check(record.sourceFingerprint === before.fingerprint && record.browserVersion === '26.6', `Source/browser mismatch: ${i + 1}`);
  check(!record.cleanupError && !record.pageErrors.length && !record.timedOut, `Execution error: ${i + 1}`);
  for (const field of ['silence', 'measurement']) {
    const measurement = record[field];
    if (!measurement) { issues.push(`Missing ${field}: ${i + 1}`); continue; }
    try {
      const actual = pcmWindowFeatures(measurement.parameters, restorePcmSnapshot(measurement.snapshot));
      for (const key of ['onset', 'rms', 'peak', 'samples', 'rate']) check(equal(actual[key], measurement.features[key]), `PCM mismatch: ${i + 1}/${field}/${key}`);
      check(actual.amplitudes.length === measurement.features.amplitudes.length && actual.amplitudes.every((v, j) => equal(v, measurement.features.amplitudes[j])), `Spectrum mismatch: ${i + 1}/${field}`);
      check(equal(measurement.parameters.end - measurement.parameters.start, field === 'silence' ? .12 : .18), `Window changed: ${i + 1}/${field}`);
      check(actual.rate === 44100, `Sample rate changed: ${i + 1}`);
      if (field === 'silence') check(actual.peak === 0, `Silent precondition failed: ${i + 1}`);
      else {
        const onsetMs = actual.onset === null ? null : (actual.onset - record.keyAt) * 1000;
        check(equal(onsetMs, record.onsetMs), `Onset mismatch: ${i + 1}`);
        check((actual.onset !== null && actual.onset >= record.keyAt && actual.onset <= record.keyAt + .09) === record.passed90ms, `90ms verdict mismatch: ${i + 1}`);
        check((actual.rms > .008 && actual.peak < .5) === record.amplitudePassed, `Amplitude verdict mismatch: ${i + 1}`);
      }
      verifiedWindows++;
    } catch (error) { issues.push(`Invalid PCM: ${i + 1}/${field}: ${error.message}`); }
  }
  const segments = analyzeTimeline(record);
  check(JSON.stringify(segments) === JSON.stringify(record.segments), 'Timeline replay differs: ' + (i + 1));
  if (record.group !== 'A') check(segments.status === 'complete', `Incomplete timeline: ${i + 1}: ${(segments.issues ?? []).join(', ')}`);
  if (record.outcome !== 'within-budget' || record.pageErrors.length || segments.status === 'incomplete') {
    for (const name of ['trace.zip', 'failure.png']) {
      try { await access(path.join(archive, path.dirname(record.record), name)); }
      catch { issues.push(`Missing failure evidence: ${i + 1}/${name}`); }
    }
  }
}
const groups = {};
for (const group of ['A', 'B', 'C']) {
  const selected = records.filter(record => record.group === group), valid = selected.filter(record => record.measurementValid);
  const traces = selected.filter(record => record.segments?.status === 'complete');
  const segments = {};
  for (const domain of ['mainMs', 'audioMs']) {
    segments[domain] = {};
    for (const key of Object.keys(traces[0]?.segments[domain] ?? {})) {
      const values = traces.map(record => record.segments[domain][key]).filter(Number.isFinite).sort((a, b) => a - b);
      segments[domain][key] = { ...latencyStats(values), min: values[0] ?? null };
    }
  }
  groups[group] = { label: manifest.groups[group].label, attempted: selected.length, valid: valid.length,
    passed: valid.filter(record => record.passed90ms && record.amplitudePassed).length,
    late: valid.filter(record => record.onsetMs !== null && record.onsetMs > 90).length,
    censored: valid.filter(record => record.onsetMs === null).length,
    latencyMs: latencyStats(valid.map(record => record.onsetMs)), diagnosticComplete: traces.length, segments,
    failedAttempts: selected.filter(record => record.outcome !== 'within-budget').map(record => record.number) };
}
const summary = { complete: completion.complete && !issues.length, attempted: records.length, sourceFingerprint: before.fingerprint,
  groups, integrity: { verifiedAssets, verifiedWindows, issues },
  productAcceptance: 'Still unverified; this run is diagnosis only, not full desktop acceptance',
  limitations: ['Local headless WebKit 26.6, software rendering and private PulseAudio; no claim about hardware audible latency or CI.',
    'Main durations use performance.now; audio durations use sample/context time. They are not interchangeable wall-clock latencies.',
    'Output timestamps are auxiliary, never used to revise the original 90ms verdict. Missing support is retained.',
    'A/B checks instrumentation association; B/C checks association with the omitted game workload. Neither comparison alone proves browser causation.',
    'All planned attempts are retained. No onset within 180ms is right-censored, never filled with zero.'],
};
await writeFile(path.join(archive, 'summary.json'), JSON.stringify(summary, null, 2));
const metric = value => value?.censored ? '>=180' : value?.value?.toFixed(2) ?? 'n/a';
const lines = ['Opening latency diagnostic', `Evidence complete: ${summary.complete}`, `Source: ${before.fingerprint}`, '',
  'Group | valid | pass | late | censored | median ms | p95 ms | max ms'];
for (const [group, value] of Object.entries(groups)) lines.push(`${group} ${value.label} | ${value.valid}/24 | ${value.passed}/24 | ${value.late} | ${value.censored} | ${metric(value.latencyMs.median)} | ${metric(value.latencyMs.p95)} | ${metric(value.latencyMs.max)}`);
for (const group of ['B', 'C']) {
  lines.push('', `${group} segment timings (median / p95 / maximum; main and audio clock domains remain separate)`);
  for (const [domain, values] of Object.entries(groups[group].segments)) for (const [key, value] of Object.entries(values))
    lines.push(`${domain}.${key}: ${metric(value.median)} / ${metric(value.p95)} / ${metric(value.max)}`);
}
lines.push('', 'Failed diagnostic samples:');
for (const record of records.filter(record => record.group !== 'A' && record.outcome !== 'within-budget'))
  lines.push(JSON.stringify({ attempt: record.number, group: record.group, onsetMs: record.onsetMs,
    mainMs: record.segments?.mainMs, audioMs: record.segments?.audioMs, issues: record.segments?.issues }));
lines.push('', `PCM replayed: ${verifiedWindows}/144; verified assets: ${verifiedAssets}`, `Integrity issues: ${JSON.stringify(issues)}`, '', ...summary.limitations, '', summary.productAcceptance);
await writeFile(path.join(archive, 'report.txt'), lines.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.complete ? 0 : 1;
