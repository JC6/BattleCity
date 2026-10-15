import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameAudio } from '../../src/platform/audio';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';
import { SCORE_TIMING } from '../../src/game/score-timeline';
import type { AudioMessage, AudioReply } from '../../src/platform/apu-worklet';
import type { ApuDriver } from '../../src/platform/apu-driver';
import type { ApuSynth } from '../../src/platform/apu-synth';

class Gain {
  value = 0;
  parameterReads = 0;
  writeAttempts: number[] = [];
  writes: number[] = [];
  failNextWrite?: Error;
  private readonly parameter: { value: number };
  connect = vi.fn();
  constructor() {
    const gain = this;
    this.parameter = {
      get value() { return gain.value; },
      set value(value: number) {
        gain.writeAttempts.push(value);
        const failure = gain.failNextWrite;
        if (failure) { gain.failNextWrite = undefined; throw failure; }
        gain.value = value; gain.writes.push(value);
      },
    };
  }
  get gain() { this.parameterReads++; return this.parameter; }
}
class Context {
  static instances: Context[] = [];
  static load: () => Promise<void> = async () => {};
  static initialState = 'running';
  static resumeContext: (context: Context) => Promise<void> = async context => { context.state = 'running'; };
  currentTime = 1; sampleRate = 44100; state = Context.initialState; destination = {};
  gain = new Gain(); audioWorklet = { addModule: vi.fn(() => Context.load()) };
  constructor() { Context.instances.push(this); }
  resume = vi.fn(() => Context.resumeContext(this));
  createGain() { return this.gain; }
}
class Node {
  static instances: Node[] = [];
  messages: AudioMessage[] = [];
  connect = vi.fn();
  port = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (message: AudioMessage) => this.messages.push(message) };
  constructor() { Node.instances.push(this); }
  acknowledge(credits = 12) {
    const frame = this.messages.findLast(message => message.type === 'frames');
    if (frame?.type === 'frames') this.port.onmessage?.({ data: {
      type: 'ack', generation: frame.generation, sequence: frame.sequence, accepted: true, credits,
    } });
  }
  progress(credits: number, nextAt: number) {
    const frame = this.messages.findLast(message => message.type === 'frames');
    if (frame?.type === 'frames') this.port.onmessage?.({ data: {
      type: 'progress', generation: frame.generation, sequence: frame.sequence, credits, nextAt,
    } });
  }
}
function fixture() {
  const state = new GameEngine(getLevel(1), { stage: 1, mode: 'single', seed: 1 }).state;
  state.phase = 'playing'; state.tanks[0].spawnTicks = 0; return state;
}
async function enabled() {
  const audio = new GameAudio(0.3); audio.unlock(); await Promise.resolve(); await Promise.resolve();
  return { audio, context: Context.instances[0], node: Node.instances[0] };
}
async function tick(audio: GameAudio, node: Node) { audio.advanceTick(); await Promise.resolve(); node.acknowledge(); }
function cues(node: Node): number[] { return node.messages.flatMap(message => message.type === 'frames' ? message.frames.flatMap(frame => frame.start) : []); }
function deferResumes(): (() => void)[] {
  Context.initialState = 'suspended';
  const finish: (() => void)[] = [];
  Context.resumeContext = context => new Promise<void>(resolve => {
    finish.push(() => { context.state = 'running'; resolve(); });
  });
  return finish;
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }
beforeEach(() => {
  Context.instances = []; Context.load = async () => {}; Context.initialState = 'running';
  Context.resumeContext = async context => { context.state = 'running'; };
  Node.instances = []; vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Node);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('tick-driven Worklet audio adapter', () => {
  it('writes each gain transition once across native scene and pause barriers', async () => {
    const { audio, context, node } = await enabled(), gain = context.gain;
    expect(gain.parameterReads).toBe(1);
    expect(gain.writes).toEqual([0]);
    for (let gesture = 0; gesture < 3; gesture++) audio.unlock();
    await settle();
    audio.play([{ type: 'stage-start' }]);
    expect(gain.value).toBe(0); // Real reset proof still gates the first scene.
    await tick(audio, node);
    expect(gain.value).toBe(0.3);
    for (let fire = 0; fire < 2; fire++) audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.setPaused(true, 'focus'); expect(gain.value).toBe(0);
    audio.setPaused(true, 'manual'); expect(gain.value).toBe(0.3);
    audio.setPaused(false); expect(gain.value).toBe(0.3);
    audio.stopScene(); expect(gain.value).toBe(0);
    await tick(audio, node); expect(gain.value).toBe(0);
    expect(gain.parameterReads).toBe(1);
    expect(gain.writeAttempts).toEqual([0, 0.3, 0, 0.3, 0]);
    expect(gain.writes).toEqual(gain.writeAttempts);
    expect(context.resume).not.toHaveBeenCalled();
  });
  it('retries the same gain target after a native setter throws', async () => {
    const { audio, context, node } = await enabled(), gain = context.gain;
    await tick(audio, node); // Empty frame proves reset reception without unmuting.
    const failure = new Error('Native gain write failed'); gain.failNextWrite = failure;
    expect(() => audio.startPresentation('hiscore')).toThrow(failure);
    expect(gain.value).toBe(0);
    expect(gain.writes).toEqual([0]);
    audio.startPresentation('hiscore');
    expect(gain.value).toBe(0.3);
    expect(gain.writeAttempts).toEqual([0, 0.3, 0.3]);
    expect(gain.writes).toEqual([0, 0.3]);
    expect(gain.parameterReads).toBe(1);
    await tick(audio, node);
    expect(cues(node)).toEqual([CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle]);
  });
  it('loads once and preserves queued cues and music progress across ordinary running gestures', async () => {
    const { audio, context, node } = await enabled();
    let stateReads = 0;
    Object.defineProperty(context, 'state', { configurable: true, get: () => { stateReads++; return 'running'; } });
    audio.unlock(); expect(stateReads).toBe(1);
    Object.defineProperty(context, 'state', { configurable: true, writable: true, value: 'running' });
    expect(Context.instances).toHaveLength(1); expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(context.resume).not.toHaveBeenCalled(); expect(node.connect).toHaveBeenCalledWith(context.gain);
    expect(context.gain.gain.value).toBe(0);
    audio.play([{ type: 'stage-start' }]); await tick(audio, node);
    expect(context.gain.gain.value).toBe(0.3);
    const resets = node.messages.filter(message => message.type === 'reset');
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    for (let index = 0; index < 3; index++) audio.unlock();
    expect(context.resume).not.toHaveBeenCalled();
    await settle(); await tick(audio, node);
    expect(node.messages.filter(message => message.type === 'reset')).toEqual(resets);
    expect(cues(node)).toEqual([CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.shot]);
    const finish = deferResumes(); context.state = 'suspended'; audio.unlock();
    expect(context.resume).toHaveBeenCalledOnce();
    finish[0](); await settle();
    expect(node.messages.findLast(message => message.type === 'reset')).toMatchObject({ generation: 1, tick: 2, offset: 2 });
    expect(context.gain.gain.value).toBe(0); // Recovered scene still needs current-generation ACK proof.
  });
  it('keeps native resume pending when the context is running but its recovery barrier is unresolved', async () => {
    const { audio, context, node } = await enabled();
    audio.play([{ type: 'stage-start' }]); await tick(audio, node);
    const finish = deferResumes(); context.state = 'suspended'; audio.unlock();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.gain.gain.value).toBe(0);
    const resets = node.messages.filter(message => message.type === 'reset');
    context.state = 'running'; // Native state may change before its resume promise settles.
    audio.unlock(); expect(context.resume).toHaveBeenCalledTimes(2);
    expect(node.messages.filter(message => message.type === 'reset')).toEqual(resets);
    expect(context.gain.gain.value).toBe(0);
    audio.advanceTick(); audio.commitFrame();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    finish[1](); await settle();
    const recovered = node.messages.filter(message => message.type === 'reset');
    expect(recovered).toHaveLength(resets.length + 1);
    expect(recovered.at(-1)).toEqual({ type: 'reset', generation: 1, tick: 2, offset: 2,
      start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2] });
    finish[0](); await settle();
    expect(node.messages.filter(message => message.type === 'reset')).toEqual(recovered);
    expect(context.gain.gain.value).toBe(0);
    await tick(audio, node); expect(context.gain.gain.value).toBe(0.3);
  });
  it('keeps a stopped scene muted across empty menu and score acknowledgements', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore'); await tick(audio, node);
    expect(context.gain.gain.value).toBe(0.3);
    audio.stopScene();
    expect(context.gain.gain.value).toBe(0);
    await tick(audio, node);
    expect(context.gain.gain.value).toBe(0);
    const state = fixture(); state.phase = 'lost';
    audio.updateScore(state, 0); await tick(audio, node);
    expect(context.gain.gain.value).toBe(0);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({ frames: [{ start: [] }] });
    state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    // Empty lead frames already proved reset reception. Restore before the
    // short count starts, without waiting for this cue's own later ACK.
    expect(context.gain.gain.value).toBe(0.3);
    audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      frames: [{ start: [CUE.countPulse, CUE.countNoise] }],
    });
  });
  it('restores scene gain only after a current generation cue is accepted, excluding stale replies and focus pause', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('gameover'); await tick(audio, node);
    const old = node.messages.findLast(message => message.type === 'frames');
    if (old?.type !== 'frames') throw new Error('No old batch');
    audio.stopScene(); audio.startPresentation('hiscore'); audio.advanceTick(); audio.commitFrame();
    const current = node.messages.findLast(message => message.type === 'frames');
    if (current?.type !== 'frames') throw new Error('No current batch');
    expect(context.gain.gain.value).toBe(0);
    node.port.onmessage?.({ data: { type: 'ack', generation: old.generation, sequence: old.sequence,
      accepted: true, credits: 12 } });
    expect(context.gain.gain.value).toBe(0);
    node.acknowledge(11);
    expect(context.gain.gain.value).toBe(0.3);
    audio.setPaused(true, 'focus'); expect(context.gain.gain.value).toBe(0);
    node.port.onmessage?.({ data: { type: 'ack', generation: current.generation, sequence: current.sequence,
      accepted: true, credits: 12 } });
    expect(context.gain.gain.value).toBe(0);
    audio.setPaused(true, 'manual'); expect(context.gain.gain.value).toBe(0.3);
    audio.setPaused(false); expect(context.gain.gain.value).toBe(0.3);
  });
  it('unmutes on an earlier accepted batch without releasing capacity reserved for the latest batch', async () => {
    const { audio, context, node } = await enabled();
    audio.play([{ type: 'stage-start' }]);
    for (let batch = 0; batch < 2; batch++) {
      for (let index = 0; index < 6; index++) audio.advanceTick();
      audio.commitFrame();
    }
    const sent = node.messages.filter(message => message.type === 'frames');
    expect(sent.map(message => message.frames.length)).toEqual([6, 6]);
    expect(context.gain.gain.value).toBe(0);
    audio.advanceTick(); audio.commitFrame(); // All twelve FIFO credits remain reserved.
    node.port.onmessage?.({ data: { type: 'ack', generation: sent[0].generation, sequence: sent[0].sequence,
      accepted: true, credits: 12 } });
    expect(context.gain.gain.value).toBe(0.3);
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
    node.progress(12, 1.3); // This latest progress must still wait for the latest reception ACK.
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
    node.acknowledge(0);
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
    context.currentTime = 1.25;
    node.progress(1, 1.3);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 3, at: 1.3,
      frames: [{ tick: 13, start: [], stop: [] }],
    });
    expect(cues(node)).toEqual([CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2]);
  });
  it('rejects malformed, pre-barrier, future and old-generation acknowledgements as reset reception proof', async () => {
    const { audio, context, node } = await enabled();
    audio.advanceTick(); audio.commitFrame();
    const old = node.messages.findLast(message => message.type === 'frames');
    if (old?.type !== 'frames') throw new Error('No old batch');
    audio.stopScene(); audio.startPresentation('hiscore');
    audio.advanceTick(); audio.commitFrame();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    audio.advanceTick(); audio.commitFrame();
    const latest = node.messages.findLast(message => message.type === 'frames');
    if (latest?.type !== 'frames') throw new Error('No latest batch');
    const valid = { type: 'ack', generation: first.generation, sequence: first.sequence, accepted: true, credits: 12 };
    const invalid = [
      { ...valid, generation: old.generation },
      { ...valid, sequence: old.sequence },
      ...[0, first.sequence + 0.5, NaN, Infinity, latest.sequence + 1, String(first.sequence)].map(sequence => ({ ...valid, sequence })),
      ...[-1, 13, 0.5, NaN, Infinity, '12', undefined].map(credits => ({ ...valid, credits })),
      { ...valid, accepted: 1 },
    ];
    const sent = node.messages.filter(message => message.type === 'frames');
    for (const message of invalid) {
      node.port.onmessage?.({ data: message });
      expect(context.gain.gain.value).toBe(0);
      expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
    }
    node.port.onmessage?.({ data: { ...valid, credits: 0 } });
    expect(context.gain.gain.value).toBe(0.3);
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
  });
  it('keeps a stopped scene silent when an earlier empty batch proves reset reception', async () => {
    const { audio, context, node } = await enabled();
    audio.stopScene();
    audio.advanceTick(); audio.commitFrame();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    audio.advanceTick(); audio.commitFrame();
    node.port.onmessage?.({ data: { type: 'ack', generation: first.generation, sequence: first.sequence,
      accepted: true, credits: 12 } });
    expect(context.gain.gain.value).toBe(0);
    audio.play([{ type: 'stage-start' }]);
    expect(context.gain.gain.value).toBe(0.3);
    audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 1, frames: [{ tick: 3, start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2], stop: [] }],
    });
  });
  it('keeps earlier reset reception proof muted until suspended-context recovery resynchronizes', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore'); audio.advanceTick(); audio.commitFrame();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    audio.advanceTick(); audio.commitFrame();
    const finish = deferResumes(); context.state = 'suspended'; audio.unlock();
    node.port.onmessage?.({ data: { type: 'ack', generation: first.generation, sequence: first.sequence,
      accepted: true, credits: 12 } });
    expect(context.gain.gain.value).toBe(0);
    finish[0](); await settle();
    expect(context.gain.gain.value).toBe(0);
    expect(node.messages.findLast(message => message.type === 'reset')).toEqual({
      type: 'reset', generation: 1, tick: 2, offset: 2,
      start: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle],
    });
    await tick(audio, node); expect(context.gain.gain.value).toBe(0.3);
  });
  it('retains persistent scene audio through recovery but waits for the recovered generation acknowledgement', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore'); await tick(audio, node);
    audio.advanceTick(); audio.commitFrame();
    const rejected = node.messages.findLast(message => message.type === 'frames');
    if (rejected?.type !== 'frames') throw new Error('No rejected batch');
    node.port.onmessage?.({ data: { type: 'ack', generation: rejected.generation, sequence: rejected.sequence,
      accepted: false, credits: 0 } });
    expect(context.gain.gain.value).toBe(0);
    expect(node.messages.findLast(message => message.type === 'reset')).toMatchObject({
      generation: 1, start: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle], offset: 2,
    });
    audio.advanceTick(); audio.commitFrame();
    expect(context.gain.gain.value).toBe(0);
    node.acknowledge(11); expect(context.gain.gain.value).toBe(0.3);
  });
  it('stops an old manual pause phrase along with its scene and keeps later empty acknowledgements silent', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore'); await tick(audio, node);
    audio.setPaused(true, 'manual'); expect(context.gain.gain.value).toBe(0.3);
    audio.stopScene(); expect(context.gain.gain.value).toBe(0);
    expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: false });
    await tick(audio, node); expect(context.gain.gain.value).toBe(0);
  });
  it('switches the native engine slots without repeated retriggering on cadence ticks', async () => {
    const { audio, node } = await enabled(); const state = fixture();
    audio.syncState(state); await tick(audio, node);
    state.tick++; state.tanks[0].moving = true; audio.syncState(state); await tick(audio, node);
    state.tick++; state.tanks[0].moving = false; audio.syncState(state); await tick(audio, node);
    state.tick++; audio.syncState(state); await tick(audio, node);
    expect(cues(node)).toEqual([CUE.enemyEngine, CUE.playerEngine, CUE.enemyEngine]);
    audio.syncState(null); await tick(audio, node);
    const last = node.messages.findLast(message => message.type === 'frames');
    expect(last).toMatchObject({ frames: [{ start: [], stop: [CUE.playerEngine, CUE.enemyEngine] }] });
  });
  it('submits completed ticks immediately and retains sample spacing across unacknowledged batches', async () => {
    const { audio, context, node } = await enabled();
    audio.play([{ type: 'stage-start' }]);
    for (let index = 0; index < 6; index++) audio.advanceTick();
    await Promise.resolve();
    const first = node.messages.findLast(message => message.type === 'frames');
    expect(first).toMatchObject({ at: context.currentTime, frames: [
      { tick: 1, start: [1, 2, 3], stop: [] },
      ...Array.from({ length: 5 }, (_, index) => ({ tick: index + 2, start: [], stop: [] })),
    ] });
    context.currentTime = 1.06;
    audio.advanceTick(); await Promise.resolve();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    const second = node.messages.findLast(message => message.type === 'frames');
    expect(second).toMatchObject({ at: 1 + 6 / 60.0988, frames: [{ tick: 7, start: [], stop: [] }] });
  });
  it('submits a fresh count at native time when the previous sample cursor is 30ms behind', async () => {
    const { audio, context, node } = await enabled();
    await tick(audio, node);
    context.currentTime = 1 + 1 / 60.0988 + 0.03;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    await tick(audio, node);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 2, at: context.currentTime,
      frames: [{ tick: 2, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
  });
  it('commits a fresh count before a 70ms paint without duplicating its actual tick in the microtask fallback', async () => {
    const { audio, context, node } = await enabled(); context.currentTime = 0;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 1, at: 0,
      frames: [{ tick: 1, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
    context.currentTime = 0.07; // Native audio time can advance during canvas painting.
    await Promise.resolve(); node.acknowledge();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    expect(cues(node)).toEqual([CUE.countPulse, CUE.countNoise]);
  });
  it('commits a fresh count within reserved capacity before an older acknowledgement delayed by painting', async () => {
    const { audio, context, node } = await enabled(); context.currentTime = 0;
    audio.advanceTick(); audio.commitFrame();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    context.currentTime = 0.009;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    audio.advanceTick(); audio.commitFrame();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 2, at: 1 / 60.0988,
      frames: [{ tick: 2, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
    context.currentTime = 0.093; // The previous ACK can dispatch only after an 84ms canvas paint.
    node.port.onmessage?.({ data: { type: 'ack', generation: first.generation, sequence: first.sequence,
      accepted: true, credits: 11 } });
    await Promise.resolve(); node.acknowledge(10);
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    expect(cues(node)).toEqual([CUE.countPulse, CUE.countNoise]);
  });
  it('expires queued old counts and shots while preserving every tick, stop and sustained cue in order', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve(); // Reserve all capacity until native consumption is acknowledged.
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [2, 0, 0, 0];
    context.currentTime = 1.001;
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    audio.play([{ type: 'stage-start' }]); audio.syncState(fixture());
    audio.advanceTick(); await Promise.resolve();
    context.currentTime = 1.05;
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs * 2);
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.startPresentation('gameover'); audio.syncState(null);
    audio.advanceTick(); await Promise.resolve();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    node.acknowledge();
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 2, at: 1 + 12 / AUDIO_TICK_HZ,
      frames: [
        { tick: 13, start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.enemyEngine],
          stop: [CUE.playerEngine, CUE.enemyEngine] },
        { tick: 14, start: [CUE.countPulse, CUE.countNoise, CUE.shot,
          CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle], stop: [CUE.playerEngine, CUE.enemyEngine] },
      ],
    });
  });
  it('uses actual consumption progress for the next pending batch sample cursor', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    context.currentTime = 1.2;
    audio.advanceTick(); await Promise.resolve();
    node.acknowledge(0);
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    node.progress(12, 1.225);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 0, sequence: 2, at: 1.225,
      frames: [{ tick: 13, start: [], stop: [] }],
    });
  });
  it('ignores an old scene acknowledgement without changing the current batch or sample cursor', async () => {
    const { audio, context, node } = await enabled();
    await tick(audio, node); audio.stopScene();
    settledActiveScene(audio);
    context.currentTime = 1.1;
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve();
    const current = node.messages.findLast(message => message.type === 'frames');
    if (current?.type !== 'frames') throw new Error('No current batch');
    context.currentTime = 1.3;
    audio.advanceTick(); await Promise.resolve();
    const sent = node.messages.filter(message => message.type === 'frames').length;
    node.port.onmessage?.({ data: { type: 'ack', generation: current.generation - 1,
      sequence: current.sequence, accepted: true, credits: 12 } });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(sent);
    node.acknowledge(0);
    node.port.onmessage?.({ data: { type: 'progress', generation: current.generation - 1,
      sequence: current.sequence, credits: 12, nextAt: 1.2 } });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(sent);
    node.progress(12, 1.345);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual({
      type: 'frames', generation: 1, sequence: 3, at: 1.345,
      frames: [{ tick: 14, start: [], stop: [] }],
    });
  });
  it('submits a fresh cue while nine accepted frames are still playing', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    for (let index = 0; index < 9; index++) audio.advanceTick();
    await Promise.resolve(); node.acknowledge(3);
    context.currentTime = 1.1;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    audio.advanceTick(); await Promise.resolve();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      sequence: 2, frames: [{ tick: 10, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
  });
  it('waits at zero credits and drains pending ticks in one-credit prefixes without losing their cues', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve(); node.acknowledge(0);
    context.currentTime = 1.005;
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.advanceTick(); await Promise.resolve();
    context.currentTime = 1.01;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, SCORE_TIMING.leadMs + SCORE_TIMING.countMs);
    audio.advanceTick(); await Promise.resolve();
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    node.progress(1, 1.02);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      sequence: 2, frames: [{ tick: 13, start: [CUE.shot], stop: [] }],
    });
    node.acknowledge(0);
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    node.progress(1, 1.04);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      sequence: 3, frames: [{ tick: 14, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(3);
  });
  it('reserves at most twelve frames across multiple unacknowledged batches and ignores older positive snapshots', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    for (let batch = 0; batch < 3; batch++) {
      for (let index = 0; index < 4; index++) audio.advanceTick();
      audio.commitFrame();
    }
    const sent = node.messages.filter(message => message.type === 'frames');
    expect(sent.map(message => message.frames.length)).toEqual([4, 4, 4]);
    audio.advanceTick(); audio.advanceTick(); audio.commitFrame();
    for (const earlier of sent.slice(0, 2)) node.port.onmessage?.({ data: {
      type: 'ack', generation: earlier.generation, sequence: earlier.sequence, accepted: true, credits: 12,
    } });
    for (const earlier of sent) node.port.onmessage?.({ data: {
      type: 'progress', generation: earlier.generation, sequence: earlier.sequence, credits: 12, nextAt: 2,
    } });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(3);
    node.acknowledge(0);
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(3);
    context.currentTime = 1.25; node.progress(1, 1.3);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      sequence: 4, at: 1.3, frames: [{ tick: 13, start: [], stop: [] }],
    });
    node.acknowledge(0); node.progress(1, 1.32);
    const all = node.messages.filter(message => message.type === 'frames');
    expect(all.map(message => message.frames.length)).toEqual([4, 4, 4, 1, 1]);
    expect(all.flatMap(message => message.frames.map(frame => frame.tick))).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(all.at(-1)).toMatchObject({ sequence: 5, at: 1.32 });
  });
  it('does not accept a progress credit snapshot while a new batch reception is still in flight', async () => {
    const { audio, node } = await enabled();
    settledActiveScene(audio);
    audio.advanceTick(); await Promise.resolve();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    node.acknowledge(1);
    audio.advanceTick(); await Promise.resolve();
    const second = node.messages.findLast(message => message.type === 'frames');
    if (second?.type !== 'frames') throw new Error('No second batch');
    audio.advanceTick(); await Promise.resolve();
    for (const sequence of [first.sequence, second.sequence]) node.port.onmessage?.({ data: {
      type: 'progress', generation: second.generation, sequence, credits: 12, nextAt: 1.1,
    } });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    node.acknowledge(0);
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    node.progress(1, 1.05);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      sequence: 3, at: 1.05, frames: [{ tick: 3, start: [], stop: [] }],
    });
  });
  it('isolates pre-pause acknowledgements and progress even within the same generation', async () => {
    const { audio, context, node } = await enabled();
    settledActiveScene(audio);
    audio.advanceTick(); await Promise.resolve();
    const old = node.messages.findLast(message => message.type === 'frames');
    if (old?.type !== 'frames') throw new Error('No old batch');
    audio.setPaused(true); audio.setPaused(false);
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve();
    const current = node.messages.findLast(message => message.type === 'frames');
    if (current?.type !== 'frames') throw new Error('No current batch');
    expect(current.generation).toBe(old.generation); expect(current.sequence).toBeGreaterThan(old.sequence);
    audio.advanceTick(); await Promise.resolve();
    const stale = [
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: true, credits: 12 },
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: false, credits: 0 },
      { type: 'progress', generation: old.generation, sequence: old.sequence, credits: 12, nextAt: 1.11 },
    ];
    for (const message of stale) node.port.onmessage?.({ data: message });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    node.acknowledge(0);
    for (const message of stale) node.port.onmessage?.({ data: message });
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(2);
    context.currentTime = 1.2; node.progress(12, 1.225);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      at: 1.225, frames: [{ tick: 14, start: [], stop: [] }],
    });
  });
  it('recovers an earlier rejected outstanding batch rather than losing sustained state behind newer posts', async () => {
    const { audio, node } = await enabled();
    audio.play([{ type: 'stage-start' }]); audio.advanceTick(); await Promise.resolve();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No first batch');
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.advanceTick(); await Promise.resolve();
    node.port.onmessage?.({ data: { type: 'ack', generation: first.generation, sequence: first.sequence,
      accepted: false, credits: 0 } });
    expect(node.messages.findLast(message => message.type === 'reset')).toMatchObject({
      generation: 1, tick: 2, offset: 2, start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2],
    });
    await tick(audio, node);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 1, frames: [{ tick: 3, start: [], stop: [] }],
    });
    expect(node.messages.flatMap(message => message.type === 'frames' && message.generation === 1 ? message.frames.flatMap(frame => frame.start) : [])).not.toContain(CUE.shot);
  });
  it('ignores a rejected old generation after scene reset without changing the new queue', async () => {
    const { audio, node } = await enabled();
    audio.advanceTick(); audio.commitFrame();
    const old = node.messages.findLast(message => message.type === 'frames');
    if (old?.type !== 'frames') throw new Error('No old batch');
    audio.stopScene(); audio.startPresentation('hiscore'); audio.advanceTick(); audio.commitFrame();
    const current = node.messages.findLast(message => message.type === 'frames');
    if (current?.type !== 'frames') throw new Error('No current batch');
    const resets = node.messages.filter(message => message.type === 'reset').length;
    node.port.onmessage?.({ data: { type: 'ack', generation: old.generation, sequence: old.sequence,
      accepted: false, credits: 0 } });
    expect(node.messages.filter(message => message.type === 'reset')).toHaveLength(resets);
    expect(node.messages.findLast(message => message.type === 'frames')).toEqual(current);
    expect(current).toMatchObject({ generation: 1, frames: [{ tick: 2,
      start: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle], stop: [] }] });
  });
  it('maps player attacks, collisions, explosions, and both bonus actions to reference slots', async () => {
    const { audio, node } = await enabled();
    audio.play([
      { type: 'fire', team: 'enemy', playerIndex: null, enemyKind: 'basic', stars: 0 },
      { type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 3 },
      { type: 'hit', target: 'brick', team: 'player', playerIndex: 0 },
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0 },
      { type: 'hit', target: 'tank', team: 'player', playerIndex: 0 },
      ...Array.from({ length: 6 }, () => ({ type: 'explosion' as const, owner: 'enemy' as const, playerIndex: null, enemyKind: 'basic' as const })),
      { type: 'explosion', owner: 'base', playerIndex: null, enemyKind: null },
      { type: 'powerup', action: 'appear', kind: 'star', playerIndex: null },
      { type: 'powerup', action: 'pickup', kind: 'star', playerIndex: 0 },
      { type: 'extra-life', playerIndex: 0, reason: 'score' },
    ]); await tick(audio, node);
    expect(cues(node)).toEqual([15, 12, 13, 14, 10, 11, 7, 9, 6, 4, 5]);
    const previous = cues(node).length;
    audio.play([
      { type: 'hit', target: 'tank', team: 'player', playerIndex: 0, tankTeam: 'player', targetPlayerIndex: 1, gunSlot: 0 },
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0, gunSlot: 8, steelPower: false },
      { type: 'hit', target: 'brick', team: 'enemy', playerIndex: null, gunSlot: 2, steelPower: false },
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0, gunSlot: 8, steelPower: true },
    ]); await tick(audio, node);
    expect(cues(node).slice(previous)).toEqual([CUE.brick]);
  });
  it('shares score count timing, deduplicates counts, and discards paused counts on resume', async () => {
    const { audio, node } = await enabled(); const state = fixture(); state.phase = 'lost'; state.players[0].kills = [2, 0, 0, 0];
    const count1 = SCORE_TIMING.leadMs + SCORE_TIMING.countMs;
    audio.updateScore(state, count1); await tick(audio, node);
    audio.updateScore(state, count1); await tick(audio, node);
    expect(cues(node)).toEqual([19, 20]);
    audio.setPaused(true); audio.updateScore(state, count1 + SCORE_TIMING.countMs); audio.advanceTick();
    audio.setPaused(false); audio.updateScore(state, count1 + SCORE_TIMING.countMs); await tick(audio, node);
    expect(cues(node)).toEqual([19, 20]);
    audio.updateScore(state, 5000); await tick(audio, node); expect(cues(node)).toEqual([19, 20]);
  });
  it('keeps zero-kill tally and loss-entry silent, starting melodies only on their presentation pages', async () => {
    const { audio, node } = await enabled(); const state = fixture(); state.phase = 'lost';
    audio.play([{ type: 'game-over' }]); audio.updateScore(state, 6000); await tick(audio, node);
    expect(cues(node)).toEqual([]);
    audio.startPresentation('gameover'); await tick(audio, node);
    expect(cues(node)).toEqual([24, 25, 26]);
    audio.stopScene(); audio.startPresentation('hiscore'); await tick(audio, node);
    expect(cues(node).slice(-3)).toEqual([21, 22, 23]);
  });
  it('only cues the cooperative 1000-point award for a winning unequal tally', async () => {
    const { audio, node } = await enabled(); const state = new GameEngine(getLevel(1), { stage: 1, mode: 'coop' }).state;
    state.players[0].kills = [1, 0, 0, 0]; state.phase = 'lost';
    audio.updateScore(state, 6000); await tick(audio, node); expect(cues(node)).not.toContain(27);
    audio.stopScene(); state.phase = 'won'; audio.updateScore(state, 6000); await tick(audio, node);
    audio.updateScore(state, 7000); await tick(audio, node); expect(cues(node).filter(id => id === 27)).toHaveLength(1);
  });
  it('distinguishes manual pause from focus silence without suspending the Context', async () => {
    const { audio, context, node } = await enabled();
    audio.setPaused(true); expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: true, reason: 'manual' });
    expect(context.gain.gain.value).toBe(0.3);
    audio.setPaused(true, 'focus'); expect(context.gain.gain.value).toBe(0);
    audio.setPaused(false); expect(context.gain.gain.value).toBe(0);
    expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: false });
    audio.syncState(fixture()); await tick(audio, node); expect(context.gain.gain.value).toBe(0.3);
  });
  it('sends the authoritative tick, discarded pending frames and uncommitted persistent controls when pausing', async () => {
    const { audio, node } = await enabled();
    expect(node.messages.find(message => message.type === 'reset')).toMatchObject({ tick: 0 });
    audio.play([{ type: 'stage-start' }]);
    for (let index = 0; index < 12; index++) audio.advanceTick();
    await Promise.resolve();
    audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
    audio.advanceTick(); await Promise.resolve();
    audio.syncState(fixture()); audio.setPaused(true, 'focus');
    expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: true, tick: 13,
      frames: [{ tick: 13, start: [CUE.shot], stop: [] }], start: [CUE.enemyEngine], stop: [CUE.playerEngine, CUE.enemyEngine] });
    const paused = node.messages.at(-1);
    if (paused?.type !== 'pause') throw new Error('No pause message');
    expect(paused.frames).toEqual([{ tick: 13, start: [CUE.shot], stop: [] }]);
    node.acknowledge(); audio.setPaused(false); await tick(audio, node);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({ frames: [{ tick: 14, start: [], stop: [] }] });
  });
  it('does not revive old short cues or scenes when asynchronous module loading completes', async () => {
    let finish!: () => void;
    Context.load = () => new Promise<void>(resolve => { finish = resolve; });
    const audio = new GameAudio(0.3); audio.unlock();
    audio.play([{ type: 'stage-start' }]); audio.stopScene(); finish(); await Promise.resolve(); await Promise.resolve();
    expect(Node.instances[0].messages.find(message => message.type === 'reset')).toMatchObject({ generation: 1, start: [] });
    expect(cues(Node.instances[0])).toEqual([]);
    expect(Context.instances[0].gain.gain.value).toBe(0);
    await tick(audio, Node.instances[0]); expect(Context.instances[0].gain.gain.value).toBe(0);
  });
  it('restores late-loaded persistent music at its actual offset after the current generation is accepted', async () => {
    let finish!: () => void;
    Context.load = () => new Promise<void>(resolve => { finish = resolve; });
    const audio = new GameAudio(0.3); audio.unlock(); audio.play([{ type: 'stage-start' }]);
    for (let index = 0; index < 3; index++) audio.advanceTick();
    finish(); await Promise.resolve(); await Promise.resolve();
    const context = Context.instances[0], node = Node.instances[0];
    expect(context.resume).not.toHaveBeenCalled();
    expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(node.messages.find(message => message.type === 'reset')).toMatchObject({
      start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2], offset: 3, tick: 3,
    });
    expect(context.gain.gain.value).toBe(0);
    await tick(audio, node); expect(context.gain.gain.value).toBe(0.3);
    expect(cues(node)).toEqual([]);
  });
  it('recovers intro at the current tick once when the module loads before multiple pending gesture resumes', async () => {
    const finish = deferResumes(), audio = new GameAudio(0.3);
    audio.stopScene(); audio.unlock();
    const context = Context.instances[0]; expect(context.resume).toHaveBeenCalledOnce();
    await settle();
    const node = Node.instances[0];
    for (let index = 0; index < 3; index++) audio.advanceTick(); // Stage selection while suspended.
    audio.unlock(); expect(context.resume).toHaveBeenCalledTimes(2);
    audio.stopScene(); // The next Start gesture opens the game before resume resolves.
    const state = fixture(); state.phase = 'intro'; audio.syncState(state);
    for (let index = 0; index < 3; index++) audio.advanceTick();
    audio.commitFrame(); expect(node.messages.some(message => message.type === 'frames')).toBe(false);
    finish[1](); await settle(); // Resolve the later gesture first.
    const resets = node.messages.filter(message => message.type === 'reset');
    expect(resets).toHaveLength(3);
    expect(resets.at(-1)).toEqual({ type: 'reset', generation: 3, tick: 6, offset: 3,
      start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2] });
    finish[0](); await settle();
    expect(node.messages.filter(message => message.type === 'reset')).toEqual(resets);
    expect(context.gain.gain.value).toBe(0);
    await tick(audio, node);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 3, frames: [{ tick: 7, start: [], stop: [] }],
    });
    expect(context.gain.gain.value).toBe(0.3);
  });
  it('initializes the current persistent offset once when resume completes before module loading', async () => {
    const finish = deferResumes(); let finishModule!: () => void;
    Context.load = () => new Promise<void>(resolve => { finishModule = resolve; });
    const audio = new GameAudio(0.3); audio.unlock(); audio.play([{ type: 'stage-start' }]);
    for (let index = 0; index < 3; index++) audio.advanceTick();
    finish[0](); await settle(); expect(Node.instances).toHaveLength(0);
    finishModule(); await settle();
    const context = Context.instances[0], node = Node.instances[0];
    expect(node.messages.filter(message => message.type === 'reset')).toEqual([
      { type: 'reset', generation: 0, tick: 3, offset: 3,
        start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2] },
    ]);
    expect(context.gain.gain.value).toBe(0);
    await tick(audio, node); expect(context.gain.gain.value).toBe(0.3);
    expect(cues(node)).toEqual([]);
  });
  it('keeps a stopped menu silent when resume completes after its scene was cleared', async () => {
    const { audio, context, node } = await enabled();
    audio.play([{ type: 'stage-start' }]); await tick(audio, node);
    const finish = deferResumes(); context.state = 'suspended'; audio.unlock();
    expect(context.gain.gain.value).toBe(0);
    audio.stopScene(); finish[0](); await settle();
    expect(node.messages.findLast(message => message.type === 'reset')).toEqual({
      type: 'reset', generation: 2, tick: 1, offset: 0, start: [],
    });
    await tick(audio, node); expect(context.gain.gain.value).toBe(0);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 2, frames: [{ tick: 2, start: [], stop: [] }],
    });
  });
  it('restores only the latest music and engine after resume, excluding old acknowledgements and credits', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('gameover'); audio.advanceTick(); audio.commitFrame();
    const old = node.messages.findLast(message => message.type === 'frames');
    if (old?.type !== 'frames') throw new Error('No old frame');
    const finish = deferResumes(); context.state = 'suspended'; audio.unlock();
    audio.stopScene(); audio.startPresentation('hiscore');
    const state = fixture(); state.tanks[0].moving = true; audio.syncState(state);
    audio.advanceTick(); audio.advanceTick();
    finish[0](); await settle();
    expect(node.messages.findLast(message => message.type === 'reset')).toEqual({
      type: 'reset', generation: 2, tick: 3, offset: 2,
      start: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle, CUE.playerEngine],
    });
    for (let index = 0; index < 12; index++) audio.advanceTick();
    audio.commitFrame(); audio.advanceTick(); audio.commitFrame();
    const frames = node.messages.filter(message => message.type === 'frames');
    for (const reply of [
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: true, credits: 12 },
      { type: 'ack', generation: old.generation, sequence: old.sequence, accepted: false, credits: 12 },
      { type: 'progress', generation: old.generation, sequence: old.sequence, credits: 12, nextAt: 9 },
    ]) node.port.onmessage?.({ data: reply });
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(frames);
    expect(node.messages.filter(message => message.type === 'reset')).toHaveLength(3);
    expect(context.gain.gain.value).toBe(0);
    node.acknowledge(0); expect(context.gain.gain.value).toBe(0.3);
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(frames);
    node.progress(1, 1.3);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 2, frames: [{ tick: 16, start: [], stop: [] }],
    });
  });
  it.each(['manual', 'focus'] as const)('keeps the current %s pause and offset when resume finishes', async reason => {
    const finish = deferResumes(), audio = new GameAudio(0.3); audio.unlock(); await settle();
    audio.play([{ type: 'stage-start' }]);
    for (let index = 0; index < 3; index++) audio.advanceTick();
    audio.setPaused(true, reason); finish[0](); await settle();
    const context = Context.instances[0], node = Node.instances[0];
    expect(node.messages.findLast(message => message.type === 'reset')).toEqual({
      type: 'reset', generation: 1, tick: 3, offset: 3,
      start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2],
    });
    expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: true, reason, tick: 3 });
    expect(node.messages.some(message => message.type === 'frames')).toBe(false);
    expect(context.gain.gain.value).toBe(reason === 'manual' ? 0.3 : 0);
    audio.setPaused(false); await tick(audio, node);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      generation: 1, frames: [{ tick: 4, start: [], stop: [] }],
    });
    expect(context.gain.gain.value).toBe(0.3);
  });
  it('allows a genuine manual pause phrase when loading completes without stopping that scene', async () => {
    let finish!: () => void;
    Context.load = () => new Promise<void>(resolve => { finish = resolve; });
    const audio = new GameAudio(0.3); audio.unlock(); audio.setPaused(true, 'manual');
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(Context.instances[0].gain.gain.value).toBe(0.3);
    expect(Node.instances[0].messages.at(-1)).toMatchObject({ type: 'pause', paused: true, reason: 'manual' });
    audio.setPaused(true, 'focus'); expect(Context.instances[0].gain.gain.value).toBe(0);
  });
  it('bounds stalled-port frames and filters stale attacks rather than replaying a backlog', async () => {
    const { audio, node } = await enabled();
    audio.advanceTick(); await Promise.resolve();
    for (let index = 0; index < 30; index++) { audio.play([{ type: 'hit', target: 'brick', team: 'player', playerIndex: 0 }]); audio.advanceTick(); await Promise.resolve(); }
    const batches = node.messages.filter(message => message.type === 'frames');
    expect(batches.every(message => message.type === 'frames' && message.frames.length <= 12)).toBe(true);
    expect(node.messages.some(message => message.type === 'reset' && message.generation > 0 && message.start.length === 0)).toBe(true);
    node.acknowledge();
    const last = node.messages.findLast(message => message.type === 'frames');
    if (last?.type !== 'frames') throw new Error('No batch');
    expect(last.frames.length).toBeLessThanOrEqual(12); expect(last.frames[0].tick).toBeGreaterThan(1);
  });
  it('leaves keyboard play usable when Context construction or Worklet loading fails', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('Audio unavailable'); } });
    const audio = new GameAudio(0.3);
    expect(() => { audio.unlock(); audio.play([{ type: 'stage-start' }]); audio.setPaused(true); audio.stopScene(); audio.advanceTick(); }).not.toThrow();
    Context.load = async () => { throw new Error('Module unavailable'); };
    vi.stubGlobal('AudioContext', Context); const second = new GameAudio(0.3); second.unlock();
    await Promise.resolve();
    expect(() => second.advanceTick()).not.toThrow();
  });
});

// A previous short cue can finish while its scene remains active. Keep this
// reachable history separate from a reset scene's genuinely silent lead.
function settledActiveScene(audio: GameAudio): void {
  Object.assign(audio as unknown as { sceneActive: boolean }, { sceneActive: true });
}

interface RealProcessor {
  port: { onmessage(event: { data: AudioMessage }): void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  driver: ApuDriver; synth: ApuSynth; nextSample: number;
}

/** Couple the actual sender to the registered Worklet, driver and synth. Only
 * native clock labels, port delivery and the destination gain are host fixtures. */
async function realReceiver() {
  const replies: AudioReply[] = [];
  let ProcessorType: (new () => RealProcessor) | undefined;
  vi.resetModules();
  vi.stubGlobal('sampleRate', 44100); vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: (_event: { data: AudioMessage }) => {}, postMessage: (reply: AudioReply) => replies.push(reply) };
  });
  vi.stubGlobal('registerProcessor', (_name: string, type: new () => RealProcessor) => { ProcessorType = type; });
  await import('../../src/platform/apu-worklet');
  if (!ProcessorType) throw new Error('Actual Worklet did not register');
  const processor = new ProcessorType();
  const { audio, context, node } = await enabled();
  const writes: { frame: number; channel: number; register: number; value: number }[] = [];
  const write = processor.synth.write.bind(processor.synth);
  vi.spyOn(processor.synth, 'write').mockImplementation((channel, register, value) => {
    writes.push({ frame: Math.ceil(processor.nextSample), channel, register, value });
    write(channel, register, value);
  });
  const pcm = new Float32Array(3 * 44100);
  let messageIndex = 0, replyIndex = 0, current = 0;
  const deliver = () => {
    while (messageIndex < node.messages.length) processor.port.onmessage({ data: node.messages[messageIndex++] });
  };
  const acknowledge = () => {
    while (replyIndex < replies.length) node.port.onmessage?.({ data: replies[replyIndex++] });
  };
  const renderUntil = (time: number) => {
    const target = Math.ceil(time * 44100);
    if (target > pcm.length || target < current) throw new Error('Invalid receiver render interval');
    while (current < target) {
      vi.stubGlobal('currentFrame', current);
      const output = new Float32Array(Math.min(128, target - current));
      expect(processor.process([], [[output]])).toBe(true);
      for (let index = 0; index < output.length; index++) output[index] *= context.gain.value;
      pcm.set(output, current); current += output.length;
    }
    vi.stubGlobal('currentFrame', current);
  };
  const rms = (start: number, end: number) => {
    const first = Math.ceil(start * 44100), last = Math.floor(end * 44100);
    if (first < 0 || last > current || last <= first) throw new Error('Unrendered receiver PCM window');
    let energy = 0;
    for (let index = first; index < last; index++) energy += pcm[index] ** 2;
    return Math.sqrt(energy / (last - first));
  };
  deliver(); renderUntil(context.currentTime);
  return { audio, context, node, processor, writes, deliver, acknowledge, renderUntil, rms };
}

describe('sender and native receiver count regressions', () => {
  it('preserves nine queued sample deadlines when a fresh count clock is only ten milliseconds later', async () => {
    const receiver = await realReceiver();
    const { audio, context, node, processor } = receiver;
    settledActiveScene(audio);
    for (let index = 0; index < 9; index++) audio.advanceTick();
    audio.commitFrame(); receiver.deliver();
    // Native receipt is acknowledged at the following actual quantum. Deliver
    // that reply before the later fresh count; all original source clocks and
    // the count PCM window below retain their existing labels.
    receiver.renderUntil(1 + 128 / 44100); receiver.acknowledge();
    const trigger = vi.spyOn(processor.driver, 'trigger');
    context.currentTime = 1.01;
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, 44 * 1000 / AUDIO_TICK_HZ);
    audio.advanceTick(); audio.commitFrame();
    const count = node.messages.findLast(message => message.type === 'frames');
    if (count?.type !== 'frames') throw new Error('Count frame missing');
    const countAt = context.currentTime;
    for (let index = 1; index <= 2; index++) {
      context.currentTime = countAt + index / AUDIO_TICK_HZ;
      audio.advanceTick(); audio.commitFrame();
    }
    receiver.deliver(); receiver.acknowledge(); receiver.renderUntil(1.3);
    const countFrameTime = 44 / AUDIO_TICK_HZ;
    expect.soft(count.at).toBeCloseTo(1 + 9 / AUDIO_TICK_HZ, 12);
    expect.soft(trigger).toHaveBeenCalledWith(CUE.countPulse);
    expect.soft(trigger).toHaveBeenCalledWith(CUE.countNoise);
    const note = receiver.writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x80);
    // Each native write begins on an integer sample, including the intervening
    // nine silent writes and the count's one-step decode/write delay.
    expect.soft(note?.frame).toBe(44100 + 10 * Math.ceil(44100 / AUDIO_TICK_HZ));
    expect(receiver.rms(countAt + 0.70 - countFrameTime, countAt + 0.90 - countFrameTime)).toBeGreaterThan(0.0005);
  });

  it('sends one reset handshake across a delayed ACK and retains count write and mute frames', async () => {
    const receiver = await realReceiver();
    const { audio, context, node, processor } = receiver;
    audio.stopScene(); receiver.deliver();
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    for (let tick = 1; tick <= 43; tick++) {
      context.currentTime = 1 + tick / AUDIO_TICK_HZ;
      audio.updateScore(state, tick * 1000 / AUDIO_TICK_HZ);
      audio.advanceTick(); audio.commitFrame(); await Promise.resolve();
      receiver.deliver(); receiver.renderUntil(context.currentTime);
    }
    expect.soft(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    const trigger = vi.spyOn(processor.driver, 'trigger');
    context.currentTime = 1 + 44 / AUDIO_TICK_HZ;
    const countAt = context.currentTime;
    audio.updateScore(state, 44 * 1000 / AUDIO_TICK_HZ);
    audio.advanceTick(); audio.commitFrame(); await Promise.resolve();
    const count = node.messages.findLast(message => message.type === 'frames');
    expect.soft(count).toMatchObject({ frames: [{ tick: 44, start: [CUE.countPulse, CUE.countNoise], stop: [] }] });
    receiver.deliver(); receiver.acknowledge();
    expect.soft(context.gain.value).toBe(0.3);
    receiver.renderUntil(countAt + 0.002);
    for (let index = 1; index <= 2; index++) {
      context.currentTime = countAt + index / AUDIO_TICK_HZ;
      audio.updateScore(state, (44 + index) * 1000 / AUDIO_TICK_HZ);
      audio.advanceTick(); audio.commitFrame(); await Promise.resolve();
      receiver.deliver(); receiver.acknowledge(); receiver.renderUntil(context.currentTime + 0.002);
    }
    receiver.renderUntil(countAt + 0.6);
    expect.soft(trigger).toHaveBeenCalledWith(CUE.countPulse);
    expect.soft(trigger).toHaveBeenCalledWith(CUE.countNoise);
    expect.soft(node.messages.filter(message => message.type === 'frames').flatMap(message => message.frames.map(frame => frame.tick)))
      .toEqual([1, 44, 45, 46]);
    const note = receiver.writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x80);
    const mute = receiver.writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x10 && note && event.frame > note.frame);
    expect.soft(note).toBeDefined(); expect.soft(mute).toBeDefined();
    const countFrameTime = 44 / AUDIO_TICK_HZ;
    expect.soft(receiver.rms(countAt + 0.70 - countFrameTime, countAt + 0.90 - countFrameTime)).toBeGreaterThan(0.0005);
    expect(receiver.rms(countAt + 1.10 - countFrameTime, countAt + 1.30 - countFrameTime)).toBeLessThan(0.0001);
  });

  it('does not transport further silent lead frames after the reset handshake is acknowledged', async () => {
    const { audio, context, node } = await enabled();
    audio.stopScene(); audio.advanceTick(); audio.commitFrame(); await Promise.resolve(); node.acknowledge();
    for (let index = 0; index < 43; index++) {
      context.currentTime += 1 / AUDIO_TICK_HZ;
      audio.advanceTick(); audio.commitFrame(); await Promise.resolve();
    }
    expect(node.messages.filter(message => message.type === 'frames')).toHaveLength(1);
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, 44 * 1000 / AUDIO_TICK_HZ); audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({
      frames: [{ tick: 45, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
  });

  it.each(['reset', 'pause'] as const)('clears a queued sample cursor only at a real %s barrier', async barrier => {
    const { audio, context, node } = await enabled(); settledActiveScene(audio);
    for (let index = 0; index < 9; index++) audio.advanceTick();
    audio.commitFrame(); node.acknowledge(3);
    context.currentTime = 1.01;
    if (barrier === 'reset') audio.stopScene();
    else { audio.setPaused(true); audio.setPaused(false); }
    const state = fixture(); state.phase = 'lost'; state.players[0].kills = [1, 0, 0, 0];
    audio.updateScore(state, 44 * 1000 / AUDIO_TICK_HZ); audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({ at: context.currentTime,
      frames: [{ tick: 10, start: [CUE.countPulse, CUE.countNoise], stop: [] }],
    });
  });
});


describe('ACK/progress coalescing candidate sender', () => {
  it('keeps the consumed hardware cursor from a latest accepted ACK', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore'); audio.advanceTick(); audio.commitFrame();
    const first = node.messages.findLast(message => message.type === 'frames');
    if (first?.type !== 'frames') throw new Error('No real frame');
    node.port.onmessage?.({ data: { type: 'ack', generation: first.generation, sequence: first.sequence, accepted: true, credits: 12, nextAt: 1.25 } });
    context.currentTime = 1.01; audio.advanceTick(); audio.commitFrame();
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({ at: 1.25, frames: [{ tick: 2, start: [], stop: [] }] });
  });
  it('uses an older accepted ACK only as reset proof, without rebasing the latest reservation', async () => {
    const { audio, context, node } = await enabled();
    audio.startPresentation('hiscore');
    for (let batch = 0; batch < 2; batch++) {
      for (let tick = 0; tick < 6; tick++) audio.advanceTick();
      audio.commitFrame();
    }
    const sent = node.messages.filter(message => message.type === 'frames');
    audio.advanceTick(); audio.commitFrame();
    node.port.onmessage?.({ data: { type: 'ack', generation: sent[0].generation, sequence: sent[0].sequence, accepted: true, credits: 12, nextAt: 9 } });
    expect(context.gain.value).toBe(0.3);
    expect(node.messages.filter(message => message.type === 'frames')).toEqual(sent);
    node.acknowledge(0);
    context.currentTime = 1.25; node.progress(1, 1.3);
    expect(node.messages.findLast(message => message.type === 'frames')).toMatchObject({ at: 1.3, frames: [{ tick: 13, start: [], stop: [] }] });
  });
});


describe('overflow recovery preserves only fresh unposted attacks', () => {
  it.each(['fresh', 'expired', 'posted', 'pause', 'suspended', 'rejected'] as const)(
    '%s attack crosses only its permitted overflow barrier into the real receiver', async scenario => {
      const receiver = await realReceiver();
      const { audio, context, node, processor } = receiver;
      settledActiveScene(audio);
      const shot = () => audio.play([{ type: 'fire', team: 'player', playerIndex: 0, enemyKind: null, stars: 0 }]);
      const emptyTicks = (count: number) => { for (let index = 0; index < count; index++) audio.advanceTick(); };
      // Reserve all twelve slots without delivering an ACK. A posted attack
      // belongs to that old batch and must never also enter overflow recovery.
      if (scenario === 'posted') shot();
      emptyTicks(12); audio.commitFrame();
      const first = node.messages.findLast(message => message.type === 'frames');
      if (first?.type !== 'frames') throw new Error('Initial reserved batch missing');
      context.currentTime = 1.002; emptyTicks(6);
      context.currentTime = 1.01;
      if (scenario !== 'posted') shot();
      audio.advanceTick(); // The real run6 shot was seventh in the pending FIFO.
      if (scenario === 'pause') { audio.setPaused(true); audio.setPaused(false); }
      if (scenario === 'suspended') {
        context.state = 'suspended'; audio.advanceTick(); audio.unlock(); await settle();
      }
      if (scenario === 'rejected') {
        node.port.onmessage?.({ data: { type: 'ack', generation: first.generation,
          sequence: first.sequence, accepted: false, credits: 0 } });
      }
      if (scenario === 'pause' || scenario === 'suspended' || scenario === 'rejected') {
        // A later unrelated overflow must not recover an attack discarded by
        // a real pause, locked-context recovery or receiver rejection.
        emptyTicks(12); audio.commitFrame(); emptyTicks(7);
      }
      context.currentTime = scenario === 'expired' ? 1.06 : 1.02;
      emptyTicks(6); // Thirteenth pending tick starts the bounded reset.
      const reset = node.messages.findLast(message => message.type === 'reset');
      if (reset?.type !== 'reset') throw new Error('Overflow reset missing');
      if (scenario === 'fresh') expect(reset.recovery).toEqual([{ at: 1.01, start: [CUE.shot] }]);
      else expect(reset.recovery).toBeUndefined();
      const trigger = vi.spyOn(processor.driver, 'trigger');
      receiver.renderUntil(context.currentTime); receiver.deliver();
      // Reset receipt must not decode or write a rescued short attack. Only
      // subsequent authoritative ticks can perform its normal decode/write.
      expect(trigger.mock.calls.filter(([id]) => id === CUE.shot)).toHaveLength(0);
      const resumedAt = context.currentTime;
      for (let index = 0; index < 3; index++) {
        context.currentTime = resumedAt + index / AUDIO_TICK_HZ;
        audio.advanceTick(); audio.commitFrame(); receiver.deliver();
        receiver.renderUntil(context.currentTime + 128 / 44100); receiver.acknowledge();
      }
      receiver.renderUntil(resumedAt + 0.10);
      expect(trigger.mock.calls.filter(([id]) => id === CUE.shot)).toHaveLength(scenario === 'fresh' ? 1 : 0);
      const energy = receiver.rms(resumedAt + 1 / AUDIO_TICK_HZ + 0.003,
        resumedAt + 2 / AUDIO_TICK_HZ + 0.001);
      if (scenario === 'fresh') expect(energy).toBeGreaterThan(0.0005);
      else expect(energy).toBe(0);
    });
});
