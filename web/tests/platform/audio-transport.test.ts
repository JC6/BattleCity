import { describe, expect, it } from 'vitest';
import { AudioTransport, type AudioEndpoint } from '../../src/platform/audio-transport';
import type { AudioMessage } from '../../src/platform/audio-protocol';
import type { AudioRuntimeHooks } from '../../src/platform/audio-runtime';
import { CUE } from '../../src/platform/audio-cues';

function fixture() {
  const messages: AudioMessage[] = [], gains: number[] = [];
  const persistent = { start: [] as number[], offset: 0 };
  let hooks!: AudioRuntimeHooks;
  const endpoint: AudioEndpoint = { status: 'ready', connected: true, ready: true, resumeSyncNeeded: false, now: 1,
    unlock() {}, setGain: value => { gains.push(value); }, post: message => { messages.push(message); },
    dispose: async () => {} };
  const transport = new AudioTransport(0.3, () => persistent, callbacks => { hooks = callbacks; return endpoint; });
  hooks.ready();
  const latest = () => messages.findLast((value): value is Extract<AudioMessage, { type: 'frames' }> => value.type === 'frames')!;
  const acknowledge = (credits = 12) => {
    const message = latest();
    hooks.reply({ type: 'ack', generation: message.generation, sequence: message.sequence, accepted: true, credits });
  };
  return { transport, messages, gains, persistent, endpoint, hooks, latest, acknowledge };
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
    const { transport, endpoint, latest, acknowledge } = fixture(); acknowledge();
    transport.cue(CUE.enemyEngine);
    for (let i = 0; i < 12; i++) transport.advanceTick();
    transport.commitFrame(); expect(latest().frames).toHaveLength(12);
    const batch = latest(); transport.cue(CUE.shot); transport.cue(CUE.stagePulse1); transport.advanceTick();
    transport.commitFrame(); expect(latest()).toBe(batch);
    Object.assign(endpoint, { now: 1.1 }); acknowledge(12);
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
});
