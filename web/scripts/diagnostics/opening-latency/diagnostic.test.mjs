import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { analyzeTimeline, latencyStats, sequence } from './common.mjs';
import { instrumentMain, instrumentWorklet } from './instrument.mjs';

function fixture() {
  const event = (kind, perfBefore, extra = {}) => ({ kind, perfBefore, perfAfter: perfBefore + .01, audioAt: 1, graph: 1, ...extra });
  return { group: 'B', keyAt: 1, onsetMs: (45020 / 44100 - 1) * 1000,
    measurement: { features: { rate: 44100, onset: 45020 / 44100 } },
    timeline: { dropped: 0, graphs: 1, timestamps: [{ supported: false }], events: [
      event('key', 1000, { code: 'Enter', pcmEventAt: 1 }),
      event('post-before', 1001, { type: 'commands', generation: 4, sequence: 1 }),
      event('post-after', 1002, { type: 'commands', generation: 4, sequence: 1 }),
      event('handler-end', 1004, { code: 'Enter' }),
    ], worklet: { rate: 44100, dropped: 0,
      rows: [[2, 44228], [4, 44228], [5, 44228], [6, 44228], [7, 44962], [8, 44962], [9, 45020]].flatMap(([kind, frame]) => [kind, frame, 4, 1, 0]) } } };
}
test('fixed sequence balances each group, position and all six permutations without replacement', () => {
  assert.equal(sequence.length, 72);
  for (const group of ['A', 'B', 'C']) {
    assert.equal(sequence.filter(item => item.group === group).length, 24);
    for (const position of [1, 2, 3]) assert.equal(sequence.filter(item => item.group === group && item.position === position).length, 8);
  }
});
test('keeps main elapsed time separate from audio-frame intervals and supports absent output timestamps', () => {
  const result = analyzeTimeline(fixture());
  assert.equal(result.status, 'complete'); assert.equal(result.mainMs.keyToPost, 1);
  assert.ok(Math.abs(result.audioMs.postToReceive - 128 / 44100 * 1000) < 1e-9);
  assert.equal(result.audioMs.thresholdToObserved, 0); assert.equal(result.outputMappingUsedForVerdict, false);
});
for (const [name, mutate] of [
  ['missing send', r => r.timeline.events.splice(1, 1)],
  ['different context', r => r.timeline.events[2].graph = 2],
  ['missing apply', r => r.timeline.worklet.rows.splice(10, 5)],
  ['out-of-order main', r => r.timeline.events[2].perfBefore = 999],
  ['out-of-order worklet', r => r.timeline.worklet.rows[21] = 44000],
  ['overflow', r => r.timeline.worklet.dropped = 1],
  ['wrong generation', r => r.timeline.worklet.rows[2] = 5],
  ['wrong key anchor', r => r.timeline.events[0].pcmEventAt = 2],
]) test(`rejects ${name} evidence`, () => {
  const record = fixture(); mutate(record); assert.equal(analyzeTimeline(record).status, 'incomplete');
});
test('no onset within 180ms remains censored even if diagnostic records later show sound', () => {
  const record = fixture(); record.measurement.features.onset = null; record.onsetMs = null;
  const result = analyzeTimeline(record); assert.equal(result.status, 'complete'); assert.equal(result.censored, true);
  assert.equal(result.audioMs.thresholdToObserved, null);
  const stats = latencyStats([20, 30, null]); assert.equal(stats.median.value, 30); assert.equal(stats.p95.censored, true);
});
test('instrumentation refuses changed anchors instead of silently observing the wrong code', () => {
  assert.throws(() => instrumentMain('', 'src/platform/audio-runtime.ts'), /anchor changed/);
  assert.throws(() => instrumentWorklet(''), /anchor changed/);
});

const archive = process.env.OPENING_ARCHIVE;
assert.ok(archive, 'OPENING_ARCHIVE must point to the newly built experiment');
const manifest = JSON.parse(await readFile(path.join(archive, 'build-manifest.json'), 'utf8'));
async function processor(group, rate) {
  let Type;
  const replies = [], context = vm.createContext({ Float32Array, Float64Array, sampleRate: rate, currentFrame: 0,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: message => replies.push(message) }; },
    registerProcessor: (_name, type) => { Type = type; },
  });
  const module = new vm.SourceTextModule(await readFile(path.join(archive, 'builds', group, manifest.groups[group].worklet), 'utf8'), { context });
  await module.link(() => { throw new Error('Worklet asset should be self-contained'); }); await module.evaluate();
  const instance = new Type();
  return { replies, send: data => instance.port.onmessage({ data }),
    render(samples, quantum) {
      const pcm = new Float32Array(samples);
      for (let i = 0; i < samples; i += quantum) {
        const output = new Float32Array(Math.min(quantum, samples - i));
        assert.equal(instance.process([], [[output]]), true); pcm.set(output, i); context.currentFrame += output.length;
      }
      return pcm;
    } };
}
for (const rate of [44100, 48000]) for (const quantum of [64, 128, 256]) test(`instrumentation preserves PCM at ${rate}Hz / ${quantum} samples and never replies during playback`, async () => {
  const a = await processor('A', rate), b = await processor('B', rate);
  const send = message => { a.send(message); b.send(message); };
  const compare = samples => assert.deepEqual(b.render(samples, quantum), a.render(samples, quantum));
  send({ type: 'reset', generation: 1, paused: false, reason: 'manual', music: [], offset: 0, engine: null });
  compare(Math.round(rate * .12));
  send({ type: 'commands', generation: 1, sequence: 1, sentAt: .12, commands: [1, 2, 3].map(id => ({ id, start: true, createdAt: .12 })) });
  compare(Math.round(rate * .3));
  send({ type: 'pause', generation: 1, sequence: 2, paused: true, reason: 'manual', commands: [] }); compare(Math.round(rate * .2));
  send({ type: 'pause', generation: 1, sequence: 3, paused: false, reason: 'manual', commands: [] }); compare(rate);
  assert.equal(b.replies.length, 0);
  b.send({ type: '__opening_dump' }); assert.equal(b.replies.length, 1); assert.equal(b.replies[0].dropped, 0);
  assert.ok(b.replies[0].rows.includes(9));
});
test('full diagnostic buffer is bounded and explicitly reports loss', async () => {
  const b = await processor('B', 44100);
  for (let generation = 1; generation <= 600; generation++) b.send({ type: 'reset', generation, music: [], offset: 0, engine: null, paused: false, reason: 'manual' });
  assert.equal(b.replies.length, 0); b.send({ type: '__opening_dump' });
  assert.equal(b.replies[0].rows.length, 512 * 5); assert.equal(b.replies[0].dropped, 88);
});
