import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { instrumentMain } from './instrument.mjs';
import { instrumentLifecycleMain, instrumentLifecycleWorklet, installLifecycleTimeline,
  LIFECYCLE_EVENTS as E, LIFECYCLE_COLUMNS, LIFECYCLE_REASONS as R } from './lifecycle-instrument.mjs';
import { analyzeLifecycleTimeline } from './lifecycle-analyze.mjs';

function analysisFixture() {
  const main = (kind, perf, audioAt, extra = {}) => ({ kind, graph: 1, perfBefore: perf,
    perfAfter: perf + .01, audioAt, state: 'running', ...extra });
  const row = (kind, frame, sequence, extra = {}) => LIFECYCLE_COLUMNS.map(name => ({
    kind, frame, generation: 1, sequence, cue: -1, createdAt: -1, sentAt: -1,
    value: 0, relatedGeneration: 0, relatedSequence: 0, extra: 0, ...extra,
  })[name]);
  const shot = { type: 'commands', generation: 1, sequence: 1, sentAt: 1.01,
    commands: [{ id: 15, start: true, createdAt: 1.01 }] };
  const focus = { type: 'pause', generation: 1, sequence: 2, paused: true, reason: 'focus', commands: [] };
  const pcm = new Float32Array(128);
  return { diagnostic: true, anchors: { shotAt: 1, blurAt: 2 },
    measurements: { shot: { status: 'passed' }, focusSilence: { status: 'passed',
      parameters: { start: 2.04, end: 2.18 }, value: { features: { peak: 0 } } } },
    snapshots: [{ phase: 'focusSilence', snapshot: { ready: true, gameReady: true, errors: [], rate: 48000,
      packets: [{ frame: 96640, frames: [96640], times: [96640 / 48000], lengths: [128],
        samplesBase64: Buffer.from(pcm.buffer).toString('base64') }] } }],
    timeline: { schemaVersion: 1, graph: 1, graphs: 1, rate: 48000,
      main: { dropped: 0, events: [main('key', 1000, 1, { code: 'KeyJ', pcmEventAt: 1 }),
        main('post-before', 1008, 1.01, shot), main('post-after', 1009, 1.01, shot),
        main('blur', 2000, 2, { code: '', pcmEventAt: 2 }),
        main('post-before', 2008, 2.01, focus), main('post-after', 2009, 2.01, focus)] },
      worklet: { schemaVersion: 1, stride: 11, rate: 48000, frame: 110000, dropped: 0,
        rows: [row(E.receipt, 48640, 1, { value: 2 }),
          row(E.queue, 48640, 1, { cue: 15, createdAt: 1.01, sentAt: 1.01, value: 1 }),
          row(E.execute, 48800, 1, { cue: 15, createdAt: 1.01, sentAt: 1.01, value: 1 }),
          row(E.receipt, 96640, 2, { value: 3 }),
          row(E.pauseApplied, 96640, 2, { value: 1, extra: 1 }),
          row(E.focusOutput, 96640, 2, { value: 0, extra: 128 })].flat() } } };
}
test('analysis separates main elapsed time from audio coordinates and compares the same tap quantum', () => {
  const result = analyzeLifecycleTimeline(analysisFixture());
  assert.equal(result.status, 'complete'); assert.equal(result.shot.mainMs.eventToPost, 8);
  assert.ok(Math.abs(result.shot.audioMs.eventToPost - 10) < 1e-9);
  assert.ok(Math.abs(result.shot.audioMs.receiptToApplied - 160 / 48000 * 1000) < 1e-9);
  assert.equal(result.shot.outcome, 'shot-executed-signature-observed');
  assert.equal(result.focus.outcome, 'not-reproduced'); assert.equal(result.focus.tap.frame, 96640);
});
test('analysis reports the actual receiver branch instead of inferring expiry from a failed signature', () => {
  const record = analysisFixture(); record.measurements.shot.status = 'failed';
  assert.equal(analyzeLifecycleTimeline(record).shot.outcome, 'shot-executed-signature-failed');
  record.timeline.worklet.rows[2 * 11] = E.expired;
  record.timeline.worklet.rows[2 * 11 + 1] = 51000;
  record.timeline.worklet.rows[2 * 11 + 7] = 0;
  const expired = analyzeLifecycleTimeline(record);
  assert.equal(expired.status, 'complete'); assert.equal(expired.shot.outcome, 'receiver-expired-shot');
  assert.ok(Math.abs(expired.shot.ageAtDecisionMs.fromSend - 52.5) < 1e-9);
});
for (const [name, mutate] of [
  ['missing receipt', record => record.timeline.worklet.rows.splice(0, 11)],
  ['wrong shot source', record => record.timeline.worklet.rows[2 * 11 + 3] = 9],
  ['missing focus output', record => record.timeline.worklet.rows.splice(5 * 11, 11)],
  ['graph replacement', record => record.timeline.graphs = 2],
  ['missing main send end', record => record.timeline.main.events.splice(2, 1)],
  ['Worklet overflow', record => record.timeline.worklet.dropped = 1],
  ['PCM rate mismatch', record => record.snapshots[0].snapshot.rate = 44100],
  ['mismatched key anchor', record => record.anchors.shotAt = 1.001],
]) test(`analysis retains incomplete status for ${name}`, () => {
  const record = analysisFixture(); mutate(record); assert.equal(analyzeLifecycleTimeline(record).status, 'incomplete');
});
test('same-frame Worklet/tap disagreement is reported without claiming a device-buffer cause', () => {
  const record = analysisFixture(), samples = new Float32Array(128); samples[3] = .04;
  record.measurements.focusSilence.status = 'failed';
  record.snapshots[0].snapshot.packets[0].samplesBase64 = Buffer.from(samples.buffer).toString('base64');
  const result = analyzeLifecycleTimeline(record);
  assert.equal(result.status, 'complete'); assert.equal(result.focus.outcome, 'worklet-tap-same-frame-disagreement');
  assert.ok(result.focus.tap.peak > .039); assert.equal(result.focus.output.value, 0);
  record.snapshots[0].snapshot.packets[0].frames[0] += 128;
  const unmatched = analyzeLifecycleTimeline(record);
  assert.equal(unmatched.focus.tap, null); assert.match(unmatched.focus.tapComparison, /no output-buffer conclusion/);
});

test('source instrumentation refuses changed or duplicate anchors', () => {
  const anchor = '      node.port.postMessage(outgoing);';
  for (const instrument of [instrumentLifecycleMain, source => instrumentMain(source, 'src/platform/audio-runtime.ts')]) {
    assert.throws(() => instrument(''), /anchor changed/);
    assert.throws(() => instrument(anchor + anchor), /anchor changed/);
    const marked = instrument(anchor);
    assert.equal(marked.split('node.port.postMessage(outgoing)').length, 2);
    assert.match(marked, /post-before[\s\S]*postMessage[\s\S]*post-after/);
  }
  assert.throws(() => instrumentLifecycleWorklet(''), /anchor changed/);
  assert.equal(instrumentLifecycleMain(anchor).split('this.context').length, 3);
});

test('runtime instruments retain surrounding guards and observe the actual outgoing control', () => {
  const source = `({ post(message) {
    const node = this.node;
    if (!node) return;
    const outgoing = this.prepare(message);
      node.port.postMessage(outgoing);
    this.finished();
  } })`;
  for (const instrument of [instrumentLifecycleMain, value => instrumentMain(value, 'src/platform/audio-runtime.ts')]) {
    const events = [], marks = [], sent = [];
    const mark = (kind, message) => { events.push(kind); marks.push(message); };
    const context = vm.createContext({ __LIFECYCLE_TRACE__: { mark }, __OPENING_TRACE__: { mark } });
    const runtime = vm.runInContext(instrument(source).replaceAll('(globalThis as any)', 'globalThis'), context);
    runtime.prepare = message => { events.push('prepare'); return { ...message, generation: 2, confirm: true }; };
    runtime.finished = () => events.push('finished');
    const message = { type: 'pause', generation: 1, sequence: 3, paused: false, reason: 'focus', commands: [] };
    runtime.post(message); assert.equal(events.length, 0);
    runtime.node = { port: { postMessage: outgoing => { events.push('native-post'); sent.push(outgoing); } } };
    runtime.post(message);
    assert.deepEqual(events, ['prepare', 'post-before', 'native-post', 'post-after', 'finished']);
    assert.equal(sent.length, 1); assert.equal(sent[0].confirm, true); assert.equal(sent[0].generation, 2);
    assert.equal(marks.length, 2);
    for (const entry of marks) { assert.equal(entry.generation, 2); assert.equal(entry.sequence, 3); }
    assert.equal(message.generation, 1); assert.equal(message.confirm, undefined);
  }
});

function collector() {
  const listeners = new Map(), sent = [];
  class AudioNode { constructor(context) { this.context = context; } connect(target) { return target; } }
  class AudioWorkletNode extends AudioNode {
    port = {
      addEventListener: (_kind, callback) => { this.listener = callback; },
      removeEventListener: (_kind, callback) => { if (this.listener === callback) this.listener = null; },
      start() {},
      postMessage: message => {
        sent.push(message);
        this.listener?.({ data: { type: '__lifecycle_dump', schemaVersion: 1, stride: 11,
          rows: [], dropped: 0, frame: 48000, rate: this.context.sampleRate } });
      },
    };
  }
  const window = { __AUDIO_PCM__: { events: [] }, addEventListener: (name, callback) => listeners.set(name, callback) };
  let perf = 1;
  const sandbox = vm.createContext({ window, AudioNode, AudioWorkletNode,
    performance: { now: () => perf += .01 }, setTimeout, clearTimeout });
  vm.runInContext(`(${installLifecycleTimeline.toString()})();`, sandbox);
  const context = currentTime => ({ currentTime, sampleRate: 48000, state: 'running',
    get getOutputTimestamp() { throw new Error('Output timestamp must never be read'); } });
  const attach = audioContext => {
    const gain = new AudioNode(audioContext), node = new AudioWorkletNode(audioContext);
    window.__AUDIO_PCM__ = { context: audioContext, gain, events: [] };
    node.connect(gain); return node;
  };
  return { window, listeners, sent, context, attach, trace: window.__LIFECYCLE_TRACE__ };
}
test('collector binds actual contexts and existing PCM event anchors and dumps only once at harvest', async () => {
  const c = collector(), first = c.context(1), second = c.context(2);
  c.attach(first); c.trace.mark('post-before', { generation: 1, sequence: 1 }, first);
  c.attach(second); c.trace.mark('post-after', { generation: 1, sequence: 1 }, first);
  c.window.__AUDIO_PCM__.events.push({ kind: 'keydown', code: 'KeyJ', at: 1.9 });
  c.listeners.get('keydown')({ repeat: false, code: 'KeyJ' });
  c.window.__AUDIO_PCM__.events.push({ kind: 'blur', code: '', at: 1.95 });
  c.listeners.get('blur')();
  assert.equal(c.sent.length, 0);
  const promise = c.trace.harvest(); assert.equal(c.trace.harvest(), promise);
  const result = await promise;
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0].type, '__lifecycle_dump');
  assert.equal(result.graph, 2); assert.equal(result.graphs, 2); assert.equal(result.rate, 48000);
  assert.deepEqual(Array.from(result.main.events, e => e.graph), [1, 1, 2, 2, 2]);
  assert.equal(result.main.events[0].audioAt, 1); assert.equal(result.main.events[1].audioAt, 1);
  assert.equal(result.main.events[2].pcmEventAt, 1.9); assert.equal(result.main.events[3].pcmEventAt, 1.95);
  for (const event of result.main.events) assert.ok(event.perfAfter >= event.perfBefore);
});
test('collector keeps message identity snapshots and explicitly bounds main records', async () => {
  const c = collector(), context = c.context(1); c.attach(context);
  const message = { type: 'commands', generation: 3, sequence: 4, sentAt: 1,
    commands: [{ id: 15, start: true, createdAt: .99 }] };
  c.trace.mark('post-before', message, context); message.commands[0].id = 17;
  for (let index = 0; index < 600; index++) c.trace.mark('sample', {}, context);
  const result = await c.trace.harvest();
  assert.equal(result.main.events.length, 512); assert.equal(result.main.dropped, 90);
  assert.equal(result.main.events[0].commands[0].id, 15);
});
test('collector returns incomplete evidence when the current PCM graph has no matching Worklet', async () => {
  const c = collector(); c.attach(c.context(1));
  c.window.__AUDIO_PCM__ = { context: c.context(2), events: [] };
  const result = await c.trace.harvest();
  assert.match(result.error, /current PCM graph/); assert.equal(result.worklet, null); assert.equal(c.sent.length, 0);
});

const archive = process.env.LIFECYCLE_ARCHIVE;
assert.ok(archive, 'LIFECYCLE_ARCHIVE must point to the newly built lifecycle diagnostic');
const manifest = JSON.parse(await readFile(path.join(archive, 'build-manifest.json'), 'utf8'));
async function processor(group, rate) {
  let Type;
  const replies = [], context = vm.createContext({ Float32Array, Float64Array, sampleRate: rate, currentFrame: 0,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: message => replies.push(message) }; },
    registerProcessor: (_name, type) => { Type = type; },
  });
  const entry = manifest.groups[group];
  assert.ok(entry?.worklet, `Missing Worklet artifact for ${group}`);
  const bytes = await readFile(path.join(archive, 'builds', group, entry.worklet));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.hashes[entry.worklet]);
  const module = new vm.SourceTextModule(bytes.toString('utf8'), { context });
  await module.link(() => { throw new Error('Worklet asset should be self-contained'); }); await module.evaluate();
  const instance = new Type();
  return { replies, get frame() { return context.currentFrame; }, get now() { return context.currentFrame / rate; },
    send: data => instance.port.onmessage({ data }),
    render(samples, quantum) {
      const pcm = new Float32Array(samples);
      for (let at = 0; at < samples; at += quantum) {
        const output = new Float32Array(Math.min(quantum, samples - at));
        const secondChannel = new Float32Array(output.length);
        assert.equal(instance.process([], [[output, secondChannel]]), true);
        assert.deepEqual(secondChannel, output); pcm.set(output, at); context.currentFrame += output.length;
      }
      return pcm;
    },
    dump() {
      instance.port.onmessage({ data: { type: '__lifecycle_dump' } });
      assert.equal(replies.length, 1);
      const dump = replies[0]; assert.equal(dump.schemaVersion, 1); assert.equal(dump.stride, LIFECYCLE_COLUMNS.length);
      return { ...dump, records: Array.from({ length: dump.rows.length / dump.stride }, (_, index) =>
        Object.fromEntries(LIFECYCLE_COLUMNS.map((column, offset) => [column, dump.rows[index * dump.stride + offset]]))) };
    },
  };
}
const reset = (generation = 1, overrides = {}) => ({ type: 'reset', generation,
  paused: false, reason: 'manual', music: [], offset: 0, engine: null, ...overrides });
const command = (id, createdAt, start = true) => ({ id, start, createdAt });
const commands = (sequence, sentAt, list, generation = 1) => ({ type: 'commands', generation, sequence, sentAt, commands: list });
const pause = (sequence, paused, reason = 'manual', list = []) => ({ type: 'pause', generation: 1, sequence, paused, reason, commands: list });

for (const mode of ['test', 'production']) for (const rate of [44100, 48000]) for (const quantum of [64, 128, 256])
  test(`${mode} instrumentation preserves each PCM sample at ${rate} Hz / ${quantum} frames`, async () => {
    const baseline = await processor(`${mode}-baseline`, rate), diagnostic = await processor(`${mode}-diagnostic`, rate);
    const send = message => { baseline.send(message); diagnostic.send(message); };
    const compare = seconds => assert.deepEqual(diagnostic.render(Math.round(rate * seconds), quantum),
      baseline.render(Math.round(rate * seconds), quantum));
    send(reset()); compare(.02);
    send(commands(1, baseline.now, [1, 2, 3, 17].map(id => command(id, baseline.now)))); compare(.25);
    send(commands(2, baseline.now, [command(15, baseline.now)])); compare(.08);
    send(commands(3, baseline.now - .1, [command(15, baseline.now - .1), command(19, baseline.now - .2)])); compare(.04);
    send(commands(4, baseline.now, [command(17, baseline.now, false)]));
    send(commands(5, baseline.now, [command(17, baseline.now)]));
    send(pause(6, true)); compare(.12);
    send(commands(7, baseline.now, [command(15, baseline.now)]));
    send(pause(8, false)); compare(.08);
    send(pause(9, true, 'focus')); compare(.18);
    send(pause(10, false, 'focus')); compare(.08);
    send(commands(10, baseline.now, [command(15, baseline.now)]));
    send(commands(11, baseline.now, [command(15, baseline.now)], 0));
    send(reset(1)); send(reset(2, { engine: 17 })); compare(.1);
    assert.equal(diagnostic.replies.length, 0);
    const evidence = diagnostic.dump(); assert.equal(evidence.dropped, 0);
    assert.ok(evidence.records.some(row => row.kind === E.expired && row.cue === 15));
    assert.ok(evidence.records.some(row => row.kind === E.focusOutput && row.value === 0 && row.extra === quantum));
    // A dump is observational: rendering after it remains identical, and repeat requests do not reply.
    diagnostic.send({ type: '__lifecycle_dump' }); assert.equal(diagnostic.replies.length, 1); compare(.04);
  });

test('execution retains the cue source after a newer unrelated message advances sequence', async () => {
  const p = await processor('test-diagnostic', 48000); p.send(reset());
  p.send(commands(1, 0, [command(15, 0)])); p.send(commands(2, 0, [command(17, 0)])); p.render(1024, 128);
  const records = p.dump().records;
  const shot = records.find(row => row.kind === E.execute && row.cue === 15);
  assert.equal(shot.sequence, 1); assert.equal(shot.generation, 1); assert.equal(shot.sentAt, 0);
  assert.equal(records.find(row => row.kind === E.execute && row.cue === 17).sequence, 2);
});
test('short cue fresh at receipt can expire at the later real audio tick without changing behavior', async () => {
  const p = await processor('test-diagnostic', 48000); p.send(reset(1, { engine: 17 })); p.render(1, 1);
  p.send(commands(1, p.now - .025, [command(15, p.now - .025)]));
  p.send(commands(2, p.now, [command(19, p.now - .101)])); p.render(1024, 128);
  const rows = p.dump().records;
  const queue = rows.find(row => row.kind === E.queue && row.cue === 15);
  const expired = rows.find(row => row.kind === E.expired && row.cue === 15);
  assert.ok(queue.frame / 48000 - queue.sentAt < 2 / 60.0988);
  assert.ok(expired.frame / 48000 - expired.sentAt > 2 / 60.0988);
  assert.equal(expired.sequence, 1); assert.equal(expired.value, 0);
  assert.equal(rows.find(row => row.kind === E.expired && row.cue === 19).value, 1);
  assert.ok(!rows.some(row => row.kind === E.execute && (row.cue === 15 || row.cue === 19)));
});
test('replacement, reset and pause clearing identify the original queued command', async () => {
  const p = await processor('test-diagnostic', 48000); p.send(reset());
  p.send(commands(1, 0, [command(15, 0)])); p.send(commands(2, 0, [command(15, 0, false)]));
  p.send(pause(3, true, 'focus', [command(17, 0)]));
  p.send(pause(4, false)); p.send(commands(5, 0, [command(15, 0)])); p.send(reset(2));
  const rows = p.dump().records, replaced = rows.find(row => row.kind === E.replace);
  assert.equal(replaced.sequence, 1); assert.equal(replaced.relatedSequence, 2); assert.equal(replaced.cue, 15);
  assert.ok(rows.some(row => row.kind === E.clear && row.sequence === 2 && row.value === R.pauseClear));
  assert.ok(rows.some(row => row.kind === E.execute && row.sequence === 3 && row.cue === 17));
  assert.ok(rows.some(row => row.kind === E.clear && row.generation === 1 && row.sequence === 5 && row.value === R.resetClear));
});
test('rejections report the branch taken without recording rejected commands as queued', async () => {
  const p = await processor('test-diagnostic', 48000); p.send(reset()); p.send(reset());
  p.send(commands(1, 0, [command(15, 0)], 0)); p.send(commands(0, 0, [command(15, 0)]));
  p.send(pause(1, true)); p.send(commands(2, 0, [command(15, 0)]));
  const rows = p.dump().records;
  assert.deepEqual(rows.filter(row => row.kind === E.reject).map(row => row.value),
    [R.staleReset, R.wrongGeneration, R.staleSequence, R.paused]);
  assert.ok(!rows.some(row => row.kind === E.queue));
});
test('focus output is the actual first block and is absent if resumed before processing', async () => {
  const p = await processor('test-diagnostic', 48000); p.send(reset(1, { engine: 17 })); p.render(128, 128);
  p.send(pause(1, true, 'focus')); p.send(pause(2, false, 'focus')); p.render(128, 128);
  p.send(pause(3, true, 'focus')); const frame = p.frame; assert.ok(p.render(256, 128).every(value => value === 0));
  const outputs = p.dump().records.filter(row => row.kind === E.focusOutput);
  assert.equal(outputs.length, 1); assert.equal(outputs[0].sequence, 3);
  assert.equal(outputs[0].frame, frame); assert.equal(outputs[0].extra, 128); assert.equal(outputs[0].value, 0);
});
test('Worklet record buffer stays fixed and explicitly reports overflow without playback replies', async () => {
  const p = await processor('test-diagnostic', 48000);
  for (let generation = 1; generation <= 300; generation++) p.send(reset(generation));
  assert.equal(p.replies.length, 0); const evidence = p.dump();
  assert.equal(evidence.rows.length, 512 * 11); assert.equal(evidence.dropped, 88);
});
