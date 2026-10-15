import { describe, expect, it } from 'vitest';
import { AudioTransport, type AudioEndpoint } from '../../src/platform/audio-transport';
import type { AudioMessage, AudioReply } from '../../src/platform/audio-protocol';
import type { AudioRuntimeHooks } from '../../src/platform/audio-runtime';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';

function fixture() {
  const messages: AudioMessage[] = [], gains: number[] = [];
  const persistent = { start: [] as number[], offset: 0 };
  const clock = { now: 1 };
  let hooks!: AudioRuntimeHooks;
  const endpoint: AudioEndpoint = { status: 'ready', connected: true, ready: true, resumeSyncNeeded: false, get now() { return clock.now; },
    unlock() {}, setGain: value => { gains.push(value); }, post: message => { messages.push(message); },
    dispose: async () => {} };
  const transport = new AudioTransport(0.3, () => persistent, callbacks => { hooks = callbacks; return endpoint; });
  hooks.ready();
  const latest = () => messages.findLast((value): value is Extract<AudioMessage, { type: 'frames' }> => value.type === 'frames')!;
  const acknowledge = (credits = 12) => {
    const message = latest();
    hooks.reply({ type: 'ack', generation: message.generation, sequence: message.sequence, accepted: true, credits });
  };
  const reply = (message: AudioReply) => hooks.reply(message);
  const progress = (credits: number, nextAt: number) => {
    const { generation, sequence } = latest();
    reply({ type: 'progress', generation, sequence, credits, nextAt });
  };
  const batches = () => messages.filter((message): message is Extract<AudioMessage, { type: 'frames' }> =>
    message.type === 'frames' && message.frames.length > 0);
  return { transport, messages, gains, persistent, clock, hooks, latest, acknowledge, reply, progress, batches };
}

// Establish an active but silent scene through public controls; no native graph is needed.
function activate(transport: AudioTransport): void {
  transport.cue(CUE.shot);
  transport.setPaused(true, 'focus'); transport.setPaused(false);
}

describe('audio frame transport without native APIs', () => {
  it('keeps gain and attacks behind accepted current-generation reset proof', () => {
    const { transport, gains, hooks, latest, messages, acknowledge } = fixture();
    transport.cue(CUE.shot); transport.advanceTick(); transport.commitFrame();
    const proof = latest(); expect(proof.frames).toEqual([]); expect(gains.at(-1)).toBe(0);
    hooks.reply({ type: 'ack', generation: proof.generation + 1, sequence: proof.sequence, accepted: true, credits: 12 });
    expect(latest()).toBe(proof);
    acknowledge(); expect(gains.at(-1)).toBe(0.3);
    expect(messages.at(-1)).toMatchObject({ type: 'frames', frames: [{ tick: 1, start: [CUE.shot] }] });
  });
  it('reserves all twelve slots and expires waiting attacks without losing ticks or persistent starts', () => {
    const { transport, clock, latest, acknowledge } = fixture(); acknowledge();
    transport.cue(CUE.enemyEngine);
    for (let i = 0; i < 12; i++) transport.advanceTick();
    transport.commitFrame(); expect(latest().frames).toHaveLength(12);
    const batch = latest(); transport.cue(CUE.shot); transport.cue(CUE.stagePulse1); transport.advanceTick();
    transport.commitFrame(); expect(latest()).toBe(batch);
    clock.now = 1.1; acknowledge(12);
    expect(latest().frames).toEqual([{ tick: 13, start: [CUE.stagePulse1], stop: [] }]);
  });
  it('resynchronizes rejected outstanding ticks from the latest semantic snapshot', () => {
    const { transport, persistent, latest, hooks, messages, acknowledge } = fixture(); acknowledge();
    transport.cue(CUE.shot); transport.advanceTick(); transport.commitFrame();
    const rejected = latest(); persistent.start = [CUE.hiscoreTriangle]; persistent.offset = 47;
    hooks.reply({ type: 'ack', generation: rejected.generation, sequence: rejected.sequence, accepted: false, credits: 12 });
    expect(messages.findLast(value => value.type === 'reset')).toMatchObject({
      generation: rejected.generation + 1, tick: 1, offset: 47, start: [CUE.hiscoreTriangle],
    });
    const proof = latest(); expect(proof.frames).toEqual([]);
    hooks.reply({ type: 'ack', generation: rejected.generation, sequence: rejected.sequence, accepted: true, credits: 12 });
    expect(latest()).toBe(proof);
  });
  it('clears queued frames across a focus barrier and requires a fresh attack after resume', async () => {
    const { transport, messages, acknowledge } = fixture(); acknowledge();
    transport.cue(CUE.shot); transport.advanceTick(); transport.setPaused(true, 'focus');
    transport.setPaused(false); await Promise.resolve(); transport.commitFrame();
    expect(messages.filter(value => value.type === 'frames' && value.frames.length)).toEqual([]);
    transport.cue(CUE.shot); transport.advanceTick(); transport.commitFrame();
    expect(messages.at(-1)).toMatchObject({ type: 'frames', frames: [{ tick: 2, start: [CUE.shot] }] });
  });

  it('expires queued old counts and shots while preserving every tick, stop and sustained cue in order', async () => {
    const { transport, clock, latest, acknowledge, batches } = fixture(); acknowledge();
    activate(transport);
    for (let index = 0; index < 12; index++) transport.advanceTick();
    await Promise.resolve(); // Reserve all capacity until native consumption is acknowledged.
    clock.now = 1.001;
    transport.cue(CUE.shot);
    transport.cue(CUE.countPulse); transport.cue(CUE.countNoise);
    for (const cue of [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2]) transport.cue(cue);
    transport.stop(CUE.playerEngine); transport.stop(CUE.enemyEngine); transport.cue(CUE.enemyEngine);
    transport.advanceTick(); await Promise.resolve();
    clock.now = 1.05;
    transport.cue(CUE.countPulse); transport.cue(CUE.countNoise);
    transport.cue(CUE.shot);
    for (const cue of [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle]) transport.cue(cue);
    transport.stop(CUE.playerEngine); transport.stop(CUE.enemyEngine);
    transport.advanceTick(); await Promise.resolve();
    expect(batches()).toHaveLength(1);
    acknowledge();
    expect(latest()).toEqual({
      type: 'frames', generation: 0, sequence: 5, at: 1 + 12 / AUDIO_TICK_HZ,
      frames: [
        { tick: 13, start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.enemyEngine],
          stop: [CUE.playerEngine, CUE.enemyEngine] },
        { tick: 14, start: [CUE.countPulse, CUE.countNoise, CUE.shot,
          CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle], stop: [CUE.playerEngine, CUE.enemyEngine] },
      ],
    });
  });
  it('uses actual consumption progress for the next pending batch sample cursor', async () => {
    const { transport, clock, latest, acknowledge, progress, batches } = fixture(); acknowledge();
    activate(transport);
    for (let index = 0; index < 12; index++) transport.advanceTick();
    await Promise.resolve();
    clock.now = 1.2;
    transport.advanceTick(); await Promise.resolve();
    acknowledge(0);
    expect(batches()).toHaveLength(1);
    progress(12, 1.225);
    expect(latest()).toEqual({
      type: 'frames', generation: 0, sequence: 5, at: 1.225,
      frames: [{ tick: 13, start: [], stop: [] }],
    });
  });
  it('ignores an old scene acknowledgement without changing the current batch or sample cursor', async () => {
    const { transport, clock, latest, acknowledge, progress, reply, batches } = fixture(); acknowledge();
    transport.advanceTick(); await Promise.resolve(); acknowledge(); transport.stopScene(); acknowledge();
    activate(transport);
    clock.now = 1.1;
    for (let index = 0; index < 12; index++) transport.advanceTick();
    await Promise.resolve();
    const current = latest();
    clock.now = 1.3;
    transport.advanceTick(); await Promise.resolve();
    const sent = batches().length;
    reply({ type: 'ack', generation: current.generation - 1,
      sequence: current.sequence, accepted: true, credits: 12 });
    expect(batches()).toHaveLength(sent);
    acknowledge(0);
    reply({ type: 'progress', generation: current.generation - 1,
      sequence: current.sequence, credits: 12, nextAt: 1.2 });
    expect(batches()).toHaveLength(sent);
    progress(12, 1.345);
    expect(latest()).toEqual({
      type: 'frames', generation: 1, sequence: 6, at: 1.345,
      frames: [{ tick: 14, start: [], stop: [] }],
    });
  });
  it('submits a fresh cue while nine accepted frames are still playing', async () => {
    const { transport, clock, latest, acknowledge, batches } = fixture(); acknowledge();
    activate(transport);
    for (let index = 0; index < 9; index++) transport.advanceTick();
    await Promise.resolve(); acknowledge(3);
    clock.now = 1.1;
    transport.cue(CUE.countPulse); transport.cue(CUE.countNoise);
    transport.advanceTick(); await Promise.resolve();
    expect(batches()).toHaveLength(2);
    expect(latest()).toMatchObject({
      sequence: 5, frames: [{ tick: 10, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
  });
  it('waits at zero credits and drains pending ticks in one-credit prefixes without losing their cues', async () => {
    const { transport, clock, latest, acknowledge, progress, batches } = fixture(); acknowledge();
    activate(transport);
    for (let index = 0; index < 12; index++) transport.advanceTick();
    await Promise.resolve(); acknowledge(0);
    clock.now = 1.005;
    transport.cue(CUE.shot);
    transport.advanceTick(); await Promise.resolve();
    clock.now = 1.01;
    transport.cue(CUE.countPulse); transport.cue(CUE.countNoise);
    transport.advanceTick(); await Promise.resolve();
    expect(batches()).toHaveLength(1);
    progress(1, 1.02);
    expect(latest()).toMatchObject({
      sequence: 5, frames: [{ tick: 13, start: [CUE.shot], stop: [] }],
    });
    acknowledge(0);
    expect(batches()).toHaveLength(2);
    progress(1, 1.04);
    expect(latest()).toMatchObject({
      sequence: 6, frames: [{ tick: 14, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
    expect(batches()).toHaveLength(3);
  });
  it('reserves at most twelve frames across multiple unacknowledged batches and ignores older positive snapshots', async () => {
    const { transport, clock, latest, acknowledge, progress, reply, batches } = fixture(); acknowledge();
    activate(transport);
    for (let batch = 0; batch < 3; batch++) {
      for (let index = 0; index < 4; index++) transport.advanceTick();
      transport.commitFrame();
    }
    const sent = batches();
    expect(sent.map(message => message.frames.length)).toEqual([4, 4, 4]);
    transport.advanceTick(); transport.advanceTick(); transport.commitFrame();
    for (const earlier of sent.slice(0, 2)) reply({
      type: 'ack', generation: earlier.generation, sequence: earlier.sequence, accepted: true, credits: 12,
    });
    for (const earlier of sent) reply({
      type: 'progress', generation: earlier.generation, sequence: earlier.sequence, credits: 12, nextAt: 2,
    });
    expect(batches()).toHaveLength(3);
    acknowledge(0);
    expect(batches()).toHaveLength(3);
    clock.now = 1.25; progress(1, 1.3);
    expect(latest()).toMatchObject({
      sequence: 7, at: 1.3, frames: [{ tick: 13, start: [], stop: [] }],
    });
    acknowledge(0); progress(1, 1.32);
    const all = batches();
    expect(all.map(message => message.frames.length)).toEqual([4, 4, 4, 1, 1]);
    expect(all.flatMap(message => message.frames.map(frame => frame.tick))).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(all.at(-1)).toMatchObject({ sequence: 8, at: 1.32 });
  });
  it('does not accept a progress credit snapshot while a new batch reception is still in flight', async () => {
    const { transport, latest, acknowledge, progress, reply, batches } = fixture(); acknowledge();
    activate(transport);
    transport.advanceTick(); await Promise.resolve();
    const first = latest();
    acknowledge(1);
    transport.advanceTick(); await Promise.resolve();
    const second = latest();
    transport.advanceTick(); await Promise.resolve();
    for (const sequence of [first.sequence, second.sequence]) reply({
      type: 'progress', generation: second.generation, sequence, credits: 12, nextAt: 1.1,
    });
    expect(batches()).toHaveLength(2);
    acknowledge(0);
    expect(batches()).toHaveLength(2);
    progress(1, 1.05);
    expect(latest()).toMatchObject({
      sequence: 6, at: 1.05, frames: [{ tick: 3, start: [], stop: [] }],
    });
  });
  it('isolates pre-pause acknowledgements and progress even within the same generation', async () => {
    const { transport, clock, latest, acknowledge, progress, reply, batches } = fixture(); acknowledge();
    activate(transport);
    transport.advanceTick(); await Promise.resolve();
    const old = latest();
    transport.setPaused(true); transport.setPaused(false);
    for (let index = 0; index < 12; index++) transport.advanceTick();
    await Promise.resolve();
    const current = latest();
    expect(current.generation).toBe(old.generation); expect(current.sequence).toBeGreaterThan(old.sequence);
    transport.advanceTick(); await Promise.resolve();
    const stale: AudioReply[] = [
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: true, credits: 12 },
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: false, credits: 0 },
      { type: 'progress', generation: old.generation, sequence: old.sequence, credits: 12, nextAt: 1.11 },
    ];
    for (const message of stale) reply(message);
    expect(batches()).toHaveLength(2);
    acknowledge(0);
    for (const message of stale) reply(message);
    expect(batches()).toHaveLength(2);
    clock.now = 1.2; progress(12, 1.225);
    expect(latest()).toMatchObject({
      at: 1.225, frames: [{ tick: 14, start: [], stop: [] }],
    });
  });
  it('keeps the consumed hardware cursor from a latest accepted ACK', async () => {
    const { transport, clock, latest, reply, acknowledge } = fixture(); acknowledge();
    for (const cue of [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle]) transport.cue(cue); transport.advanceTick(); transport.commitFrame();
    const first = latest();
    reply({ type: 'ack', generation: first.generation, sequence: first.sequence, accepted: true, credits: 12, nextAt: 1.25 });
    clock.now = 1.01; transport.advanceTick(); transport.commitFrame();
    expect(latest()).toMatchObject({ at: 1.25, frames: [{ tick: 2, start: [], stop: [] }] });
  });
  it('ignores an earlier accepted credit snapshot without rebasing the latest reservation', async () => {
    const { transport, clock, gains, latest, acknowledge, progress, reply, batches } = fixture(); acknowledge();
    for (const cue of [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle]) transport.cue(cue);
    for (let batch = 0; batch < 2; batch++) {
      for (let tick = 0; tick < 6; tick++) transport.advanceTick();
      transport.commitFrame();
    }
    const sent = batches();
    transport.advanceTick(); transport.commitFrame();
    reply({ type: 'ack', generation: sent[0].generation, sequence: sent[0].sequence, accepted: true, credits: 12, nextAt: 9 });
    expect(gains.at(-1)).toBe(0.3);
    expect(batches()).toEqual(sent);
    acknowledge(0);
    clock.now = 1.25; progress(1, 1.3);
    expect(latest()).toMatchObject({ at: 1.3, frames: [{ tick: 13, start: [], stop: [] }] });
  });
});
