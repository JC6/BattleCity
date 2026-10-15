import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioMessage, AudioReply } from '../../src/platform/apu-worklet';
import type { ApuDriver } from '../../src/platform/apu-driver';
import type { ApuSynth } from '../../src/platform/apu-synth';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';

interface Processor {
  port: { onmessage: (event: { data: AudioMessage }) => void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  // Test-only inspection of the captured processor instance; no production hook.
  driver: ApuDriver;
  synth: ApuSynth;
  pauseDriver: ApuDriver;
  queue: { sourceSample: number }[];
  nextSample: number;
}
let ProcessorType: new () => Processor;
let current = 0;
beforeEach(async () => {
  vi.resetModules(); current = 0;
  vi.stubGlobal('sampleRate', 44100); vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: () => {}, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_name: string, type: new () => Processor) => { ProcessorType = type; });
  await import('../../src/platform/apu-worklet');
});
afterEach(() => vi.unstubAllGlobals());
function send(processor: Processor, data: AudioMessage): void { processor.port.onmessage({ data }); }
function acknowledgements(processor: Processor): Extract<AudioReply, { type: 'ack' }>[] {
  return processor.port.postMessage.mock.calls.map(call => call[0] as AudioReply)
    .filter((reply): reply is Extract<AudioReply, { type: 'ack' }> => reply.type === 'ack');
}
function progress(processor: Processor): Extract<AudioReply, { type: 'progress' }>[] {
  return processor.port.postMessage.mock.calls.map(call => call[0] as AudioReply)
    .filter((reply): reply is Extract<AudioReply, { type: 'progress' }> => reply.type === 'progress');
}
function render(processor: Processor, frames: number, quantum = 128): Float32Array {
  const result = new Float32Array(frames);
  for (let index = 0; index < frames; index += quantum) {
    vi.stubGlobal('currentFrame', current);
    const output = new Float32Array(Math.min(quantum, frames - index));
    expect(processor.process([], [[output]])).toBe(true);
    result.set(output, index); current += output.length;
  }
  return result;
}
describe('realtime APU processor controls', () => {
  it.each([64, 128, 256])('uses actual %s-sample quantum lengths and acknowledges applied batches once', quantum => {
    const processor = new ProcessorType(); send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 1, start: [1, 2, 3], stop: [] }, { tick: 2, start: [], stop: [] }] });
    const pcm = render(processor, 4410, quantum);
    expect(pcm.subarray(0, 700).every(value => value === 0)).toBe(true);
    expect(pcm.subarray(1000).some(value => Math.abs(value) > 0.02)).toBe(true);
    expect(acknowledgements(processor)).toEqual([{ type: 'ack', generation: 1, sequence: 1, accepted: true,
      credits: 11, nextAt: 1 / AUDIO_TICK_HZ }]);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 1, credits: 12 });
    expect(progress(processor).at(-1)?.nextAt).toBeCloseTo(
      (Math.ceil(44100 / AUDIO_TICK_HZ) + 44100 / AUDIO_TICK_HZ) / 44100, 12);
  });
  it('clears old-generation commands and emits exact silence after scene reset', () => {
    const processor = new ProcessorType(); send(processor, { type: 'reset', generation: 2, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [{ tick: 1, start: [15], stop: [] }] });
    expect(render(processor, 3000).every(value => value === 0)).toBe(true);
    send(processor, { type: 'reset', generation: 3, start: [1, 2, 3], offset: 30, tick: 30 });
    expect(render(processor, 3000).some(value => Math.abs(value) > 0.02)).toBe(true);
    send(processor, { type: 'reset', generation: 4, start: [], offset: 0, tick: 30 });
    expect(render(processor, 3000).every(value => value === 0)).toBe(true);
  });
  it.each([
    ['stage', [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2]],
    ['hiscore', [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle]],
    ['gameover', [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle]],
  ] as const)('retains delayed %s music and advances only its submitted ticks', (_name, tracks) => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 100 });
    expect(render(processor, 4410).every(value => value === 0)).toBe(true);
    const tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 101, start: [...tracks, CUE.shot], stop: [] },
      ...Array.from({ length: 5 }, (_, index) => ({ tick: 102 + index, start: [], stop: [] })),
    ] });
    expect(render(processor, 6000).some(value => Math.abs(value) > 0.02)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(6);
    for (const id of tracks) expect(processor.driver.active(id)).toBe(true);
    expect(processor.driver.active(CUE.shot)).toBe(false);
    expect(acknowledgements(processor)).toEqual([{ type: 'ack', generation: 1, sequence: 1, accepted: true,
      credits: 12, nextAt: 0.1 + 1 / AUDIO_TICK_HZ }]);
    render(processor, 3000);
    expect(tick).toHaveBeenCalledTimes(6);
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: current / 44100,
      frames: [{ tick: 107, start: [], stop: [] }] });
    render(processor, 128);
    expect(tick).toHaveBeenCalledTimes(7);
    expect(processor.driver.active(CUE.shot)).toBe(false);
  });
  it('discards delayed short attacks without a later replay or output burst', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 40 });
    render(processor, 4410);
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 41, start: [CUE.shot], stop: [] },
      { tick: 42, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 43, start: [CUE.brick], stop: [] },
    ] });
    expect(render(processor, 4410).every(value => value === 0)).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); expect(tick).toHaveBeenCalledTimes(3);
    expect(acknowledgements(processor)).toEqual([{ type: 'ack', generation: 1, sequence: 1, accepted: true,
      credits: 12, nextAt: 3 / AUDIO_TICK_HZ }]);
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: current / 44100,
      frames: [{ tick: 44, start: [], stop: [] }] });
    expect(render(processor, 4410).every(value => value === 0)).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); expect(tick).toHaveBeenCalledTimes(4);
  });
  it('plays a normally transported shot arriving less than two audio ticks late', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    expect(render(processor, 882).every(value => value === 0)).toBe(true);
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    // A 20ms native delivery delay is inside the unchanged two-tick expiry.
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 1, start: [CUE.shot], stop: [] }, { tick: 2, start: [], stop: [] },
    ] });
    expect(render(processor, 3000).some(value => Math.abs(value) > 0.02)).toBe(true);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot);
    expect(tick).toHaveBeenCalledTimes(2); expect(processor.driver.active(CUE.shot)).toBe(true);
    expect(acknowledgements(processor)).toEqual([{ type: 'ack', generation: 1, sequence: 1, accepted: true,
      credits: 11, nextAt: 0.02 + 1 / AUDIO_TICK_HZ }]);
  });
  it.each([
    ['on time', 1 / AUDIO_TICK_HZ],
    ['after 38ms native delivery', 0.038],
  ] as const)('preserves the one-frame tally attack across paired batches %s', (_name, deliveredAt) => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 1, start: [CUE.countPulse, CUE.countNoise], stop: [] }] });
    // The source decodes the note on tick 1, writes it on tick 2 and mutes it
    // on tick 3. Audio time may advance between the two real message deliveries.
    expect(render(processor, 128).every(value => value === 0)).toBe(true);
    expect(render(processor, Math.round(deliveredAt * 44100) - current).every(value => value === 0)).toBe(true);
    const writeAt = current, frameSamples = 44100 / AUDIO_TICK_HZ;
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: 1 / AUDIO_TICK_HZ,
      frames: [{ tick: 2, start: [], stop: [] }, { tick: 3, start: [], stop: [] }] });
    expect(processor.queue[0]?.sourceSample).toBe(Math.round(frameSamples));
    expect(processor.queue[1]?.sourceSample).toBeCloseTo(Math.round(frameSamples) + frameSamples, 12);
    const pcm = render(processor, 6000);
    expect(pcm.subarray(0, Math.floor(44100 / AUDIO_TICK_HZ)).some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(pcm.subarray(5000).every(value => value === 0)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(processor.driver.active(CUE.countPulse)).toBe(false);
    expect(processor.driver.active(CUE.countNoise)).toBe(false);
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 12, nextAt: 1 / AUDIO_TICK_HZ },
      { type: 'ack', generation: 1, sequence: 2, accepted: true, credits: 11, nextAt: (writeAt + frameSamples) / 44100 },
    ]);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 2, credits: 12 });
    expect(progress(processor).at(-1)?.nextAt).toBeCloseTo(
      (Math.ceil(writeAt + frameSamples) + frameSamples) / 44100, 12);
  });
  it.each([
    ['tally', [CUE.countPulse, CUE.countNoise]],
    ['player engine', [CUE.playerEngine]],
  ] as const)('appends a fresh %s attack behind a nine-frame native playback backlog', (_name, starts) => {
    const processor = new ProcessorType(), frameSamples = 44100 / AUDIO_TICK_HZ;
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick'), trigger = vi.spyOn(processor.driver, 'trigger');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: Array.from({ length: 9 }, (_, index) => ({ tick: index + 1, start: [], stop: [] })) });
    expect(render(processor, 128).every(value => value === 0)).toBe(true);
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: 9 / AUDIO_TICK_HZ, frames: [
      { tick: 10, start: [...starts], stop: [] }, { tick: 11, start: [], stop: [] }, { tick: 12, start: [], stop: [] },
    ] });
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 4, nextAt: 1 / AUDIO_TICK_HZ },
    ]);
    expect(processor.queue).toHaveLength(11);
    const pcm = render(processor, 12000);
    expect(acknowledgements(processor).at(-1)).toEqual({ type: 'ack', generation: 1, sequence: 2,
      accepted: true, credits: 1, nextAt: 1 / AUDIO_TICK_HZ });
    expect(pcm.subarray(Math.ceil(10 * frameSamples), Math.floor(11 * frameSamples))
      .some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(12);
    for (const id of starts) expect(trigger).toHaveBeenCalledWith(id);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 2, credits: 12 });
    render(processor, 1000); expect(tick).toHaveBeenCalledTimes(12);
  });
  it('preserves the current full hardware frame when an appended batch has a future source deadline', () => {
    const processor = new ProcessorType(), frameSamples = 44100 / AUDIO_TICK_HZ;
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 1, start: [CUE.countPulse, CUE.countNoise], stop: [] }, { tick: 2, start: [], stop: [] },
    ] });
    render(processor, 128);
    const beforeAppend = processor.nextSample;
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: 0.2,
      frames: [{ tick: 3, start: [], stop: [] }] });
    expect(processor.nextSample).toBe(beforeAppend);
    expect(processor.queue[1]?.sourceSample).toBe(8820);
    expect(render(processor, Math.ceil(frameSamples) - current).every(value => value === 0)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
    const firstWrite = render(processor, 1);
    expect(tick).toHaveBeenCalledTimes(2);
    const endOfFrame = Math.ceil(processor.nextSample);
    const remainingFrame = render(processor, endOfFrame - current);
    expect([...firstWrite, ...remainingFrame].some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(2);
    render(processor, 1); expect(tick).toHaveBeenCalledTimes(3);
    const endCursor = processor.nextSample;
    send(processor, { type: 'frames', generation: 1, sequence: 3, at: 0.5, frames: [] });
    expect(processor.nextSample).toBe(endCursor);
    render(processor, 6000); expect(tick).toHaveBeenCalledTimes(3);
  });
  it('rejects over-capacity batches without losing queued ticks and accepts them once capacity returns', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick'), trigger = vi.spyOn(processor.driver, 'trigger');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: Array.from({ length: 12 }, (_, index) => ({ tick: index + 1, start: [], stop: [] })) });
    const rejected = { type: 'frames', generation: 1, sequence: 2, at: 0, frames: [
      { tick: 13, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 14, start: [], stop: [] }, { tick: 15, start: [], stop: [] },
    ] } satisfies AudioMessage;
    send(processor, rejected);
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 2, accepted: false, credits: 0 },
    ]);
    expect(processor.queue).toHaveLength(12);
    expect(render(processor, 12000).every(value => value === 0)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(12); expect(trigger).not.toHaveBeenCalled();
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 1, credits: 12 });
    send(processor, { ...rejected, at: current / 44100 });
    expect(processor.queue).toHaveLength(3);
    expect(acknowledgements(processor).at(-1)?.sequence).toBe(1);
    expect(render(processor, 6000).some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(acknowledgements(processor).at(-1)).toEqual({ type: 'ack', generation: 1, sequence: 2,
      accepted: true, credits: 10, nextAt: (12000 + 44100 / AUDIO_TICK_HZ) / 44100 });
    expect(tick).toHaveBeenCalledTimes(15);
    expect(trigger.mock.calls).toEqual([[CUE.countPulse], [CUE.countNoise]]);
  });
  it('acknowledges duplicate accepted batches without appending or advancing their ticks twice', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick'), trigger = vi.spyOn(processor.driver, 'trigger');
    const batch = { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 1, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 2, start: [], stop: [] }, { tick: 3, start: [], stop: [] },
    ] } satisfies AudioMessage;
    send(processor, batch); send(processor, batch);
    expect(processor.queue).toHaveLength(3);
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 9 },
    ]);
    expect(render(processor, 6000).some(value => Math.abs(value) > 0.002)).toBe(true);
    send(processor, batch);
    expect(render(processor, 3000).every(value => value === 0)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(3); expect(trigger).toHaveBeenCalledTimes(2);
  });
  it('expires appended attacks on their original batch clock rather than the retained playback cursor', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const tick = vi.spyOn(processor.driver, 'tick'), trigger = vi.spyOn(processor.driver, 'trigger');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 1, start: [], stop: [] }, { tick: 2, start: [], stop: [] }, { tick: 3, start: [], stop: [] }] });
    render(processor, 128);
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: 0,
      frames: [{ tick: 4, start: [CUE.shot, CUE.countPulse, CUE.countNoise], stop: [] }] });
    expect(processor.queue[2]?.sourceSample).toBe(0);
    expect(render(processor, 6000).every(value => value === 0)).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); expect(tick).toHaveBeenCalledTimes(4);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 2, credits: 12 });
  });
  it('keeps original command age after rebasing preceding frames at the expiry boundary', () => {
    const processor = new ProcessorType(), frameSamples = 44100 / AUDIO_TICK_HZ;
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    render(processor, Math.floor(2 * frameSamples));
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 1, start: [], stop: [] }, { tick: 2, start: [], stop: [] }, { tick: 3, start: [], stop: [] },
      { tick: 4, start: [CUE.shot, CUE.countPulse, CUE.countNoise], stop: [] },
    ] });
    // Rounding three fresh writes to actual native samples puts the fourth
    // command just beyond 2T on its original clock, despite its new due time.
    expect(render(processor, 6000).every(value => value === 0)).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); expect(tick).toHaveBeenCalledTimes(4);
    expect(processor.queue[3]?.sourceSample).toBeCloseTo(3 * frameSamples, 12);
    expect(processor.nextSample).toBeGreaterThan(4 * frameSamples);
    expect(acknowledgements(processor)).toEqual([{ type: 'ack', generation: 1, sequence: 1, accepted: true,
      credits: 9, nextAt: (Math.floor(2 * frameSamples) + frameSamples) / 44100 }]);
  });
  it('retains a fresh tally hardware frame before later expired steps catch up', () => {
    const processor = new ProcessorType(), frameSamples = 44100 / AUDIO_TICK_HZ;
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    render(processor, Math.floor(2 * frameSamples));
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    const writes: { frame: number; channel: number; register: number; value: number }[] = [];
    const write = processor.synth.write.bind(processor.synth);
    vi.spyOn(processor.synth, 'write').mockImplementation((channel, register, value) => {
      writes.push({ frame: current, channel, register, value }); write(channel, register, value);
    });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 1, start: [], stop: [] }, { tick: 2, start: [], stop: [] },
      { tick: 3, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 4, start: [], stop: [] }, { tick: 5, start: [], stop: [] },
    ] });
    const pcm = render(processor, 6000, 1);
    expect(trigger).toHaveBeenCalledWith(CUE.countPulse);
    expect(trigger).toHaveBeenCalledWith(CUE.countNoise);
    // Tick 3 decodes this fresh one-frame attack, and tick 4 writes it.
    // Expired tick 5 must not mute that first hardware write at the same sample.
    expect(pcm.some(sample => Math.abs(sample) > 0.002)).toBe(true);
    const note = writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x80)!;
    const mute = writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x10 && event.frame >= note.frame)!;
    expect(note.frame).toBe(3669);
    expect(mute.frame - note.frame).toBeGreaterThanOrEqual(frameSamples);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(processor.queue[2]?.sourceSample).toBeCloseTo(2 * frameSamples, 12);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 1, sequence: 1, credits: 12 });
  });
  it.each(['reset', 'pause'] as const)('clears the prior fresh hardware hold at a %s barrier', barrier => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 100 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 101, start: [CUE.countPulse, CUE.countNoise], stop: [] }] });
    render(processor, 1); vi.stubGlobal('currentFrame', current);
    const generation = barrier === 'reset' ? 2 : 1;
    if (barrier === 'reset') send(processor, { type: 'reset', generation, start: [], offset: 0, tick: 101 });
    else {
      send(processor, { type: 'pause', generation, paused: true, reason: 'focus', tick: 101, frames: [], start: [], stop: [] });
      send(processor, { type: 'pause', generation, paused: false, reason: 'focus', tick: 101, frames: [], start: [], stop: [] });
    }
    render(processor, 1700);
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    // The first step is expired; the tally's own original age is still <2T.
    // A hold from before the barrier must not delay and expire this new tally.
    send(processor, { type: 'frames', generation, sequence: 2, at: 0, frames: [
      { tick: 102, start: [], stop: [] }, { tick: 103, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 104, start: [], stop: [] }, { tick: 105, start: [], stop: [] },
    ] });
    render(processor, 5000);
    for (const id of [CUE.countPulse, CUE.countNoise]) expect(trigger.mock.calls.filter(call => call[0] === id)).toHaveLength(1);
    expect(tick).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['shot', [CUE.shot]],
    ['tally', [CUE.countPulse, CUE.countNoise]],
  ] as const)('plays a timely %s behind an expired native playback backlog', (_name, starts) => {
    const processor = new ProcessorType();
    // Native WebKit capture: sequence 595 arrived 1,090 samples before its
    // source deadline. Three older commands already owed about two ticks.
    // Keep only the captured queue/cursor and subsequent real receive times.
    current = 580352; vi.stubGlobal('currentFrame', current);
    send(processor, { type: 'reset', generation: 6, start: [], offset: 0, tick: 828 });
    Object.assign(processor, { sequence: 594, nextSample: 580708.3335174741, queue: [
      { tick: 829, start: [], stop: [], sourceSample: 579241 },
      { tick: 830, start: [], stop: [], sourceSample: 579974 },
      { tick: 831, start: [], stop: [], sourceSample: 580707.7916896843 },
    ] });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 6, sequence: 595, at: 13.184625925499779,
      frames: [{ tick: 832, start: [...starts], stop: [] }] });
    const attack = processor.queue[3];
    expect(attack.sourceSample).toBe(581442);
    expect(current).toBeLessThan(attack.sourceSample);
    render(processor, 256);
    send(processor, { type: 'frames', generation: 6, sequence: 596, at: 13.201265192839559,
      frames: [{ tick: 833, start: [], stop: [] }] });
    render(processor, 896);
    send(processor, { type: 'frames', generation: 6, sequence: 597, at: 13.217904460179339,
      frames: [{ tick: 834, start: [], stop: [] }] });
    render(processor, 768);
    send(processor, { type: 'frames', generation: 6, sequence: 598, at: 13.23454372751912,
      frames: [{ tick: 835, start: [], stop: [] }, { tick: 836, start: [], stop: [] }] });
    const pcm = render(processor, 4000);
    for (const id of starts) expect(trigger.mock.calls.filter(call => call[0] === id)).toHaveLength(1);
    expect(pcm.some(sample => Math.abs(sample) > 0.002)).toBe(true);
    expect(attack.sourceSample).toBe(581442);
    expect(tick).toHaveBeenCalledTimes(8);
    expect(progress(processor).at(-1)).toMatchObject({ generation: 6, sequence: 598, credits: 12 });
  });
  it('clears queued source deadlines and resets playback at the actual hardware frame across scene reset and pause', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0.2,
      frames: [{ tick: 1, start: [CUE.shot], stop: [] }] });
    render(processor, 128); vi.stubGlobal('currentFrame', current);
    send(processor, { type: 'reset', generation: 2, start: [], offset: 0, tick: 1 });
    expect(processor.queue).toEqual([]); expect(processor.nextSample).toBe(current);
    send(processor, { type: 'frames', generation: 2, sequence: 2, at: 0.3,
      frames: [{ tick: 2, start: [CUE.shot], stop: [] }] });
    send(processor, { type: 'pause', generation: 2, paused: true, reason: 'focus', tick: 2, frames: [], start: [], stop: [] });
    expect(processor.queue).toEqual([]); expect(processor.nextSample).toBe(current);
    expect(render(processor, 128).every(value => value === 0)).toBe(true);
    vi.stubGlobal('currentFrame', current);
    send(processor, { type: 'pause', generation: 2, paused: false, reason: 'focus', tick: 2, frames: [], start: [], stop: [] });
    expect(processor.queue).toEqual([]); expect(processor.nextSample).toBe(current);
    expect(render(processor, 1000).every(value => value === 0)).toBe(true);
    expect(progress(processor)).toEqual([]);
  });
  it('plays a bounded manual pause cue and switches focus pause to exact silence', () => {
    const processor = new ProcessorType(); send(processor, { type: 'reset', generation: 1, start: [1], offset: 20, tick: 20 });
    send(processor, { type: 'pause', generation: 1, paused: true, reason: 'manual', tick: 20, frames: [], start: [], stop: [] });
    expect(render(processor, 12000).some(value => Math.abs(value) > 0.02)).toBe(true);
    render(processor, 18000);
    expect(render(processor, 2000).every(value => value === 0)).toBe(true);
    send(processor, { type: 'pause', generation: 1, paused: true, reason: 'focus', tick: 20, frames: [], start: [], stop: [] });
    expect(render(processor, 2000).every(value => value === 0)).toBe(true);
    send(processor, { type: 'pause', generation: 1, paused: false, reason: 'manual', tick: 20, frames: [], start: [], stop: [] });
    expect(render(processor, 2000).some(value => Math.abs(value) > 0.02)).toBe(true);
  });
  it.each([
    [44100, 64], [44100, 128], [44100, 256], [48000, 64], [48000, 128], [48000, 256],
  ])('retains the final claimed manual-pause frame and mute sample at %i Hz with %i-sample quanta', async (rate, quantum) => {
    const [{ ApuDriver }, { ApuSynth }] = await Promise.all([
      import('../../src/platform/apu-driver'), import('../../src/platform/apu-synth'),
    ]);
    const frameSamples = rate / AUDIO_TICK_HZ;
    // The independent pause bus golden stops slot 00 on tick 37 and mutes on
    // tick 38. Its final claimed frame starts at sample ceil(36 * frameSamples).
    const stoppedAt = Math.ceil(36 * frameSamples), mutedAt = Math.ceil(37 * frameSamples);
    const synth = new ApuSynth(rate), driver = new ApuDriver((c, r, v) => synth.write(c, r, v));
    driver.trigger(CUE.pause);
    const reference = new Float32Array(mutedAt + 1);
    let nextTick = 0;
    for (let sample = 0; sample < reference.length; sample++) {
      if (sample >= nextTick) { driver.tick(true); nextTick += frameSamples; }
      reference[sample] = synth.sample();
    }
    expect(reference.subarray(stoppedAt + 1, mutedAt).some(value => value !== 0)).toBe(true);
    vi.stubGlobal('sampleRate', rate);
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'pause', generation: 1, paused: true, reason: 'manual', tick: 0, frames: [], start: [], stop: [] });
    const tick = vi.spyOn(processor.pauseDriver, 'tick');
    const prior = render(processor, stoppedAt, quantum);
    const finalFrame = render(processor, mutedAt - stoppedAt, quantum);
    expect(processor.pauseDriver.active(CUE.pause)).toBe(false);
    expect(processor.pauseDriver.hasActivity()).toBe(true);
    expect(tick).toHaveBeenCalledTimes(37);
    const expectedFrame = reference.subarray(stoppedAt, mutedAt);
    expect(finalFrame).toHaveLength(expectedFrame.length);
    const mismatches = finalFrame.reduce((count, value, index) => count + Number(value !== expectedFrame[index]), 0);
    expect(mismatches, 'The complete final claimed hardware frame must match the independent PCM').toBe(0);
    // Retain the existing one sample after the actual mute write, then stop
    // immediately. This does not add the ordinary processor's filter tail.
    const mute = render(processor, 1, quantum);
    expect(mute[0]).toBe(reference[mutedAt]);
    const complete = new Float32Array(reference.length);
    complete.set(prior); complete.set(finalFrame, stoppedAt); complete.set(mute, mutedAt);
    expect(complete.reduce((count, value, index) => count + Number(value !== reference[index]), 0),
      'All pause PCM through the actual mute sample must match the independent driver and synth').toBe(0);
    expect(tick).toHaveBeenCalledTimes(38);
    expect(processor.pauseDriver.hasActivity()).toBe(false);
    const activity = vi.spyOn(processor.pauseDriver, 'hasActivity');
    expect(render(processor, rate, quantum).every(value => value === 0)).toBe(true);
    expect(activity).toHaveBeenCalled();
    expect(activity.mock.calls.length).toBeLessThanOrEqual(Math.ceil(rate / quantum));
    expect(tick).toHaveBeenCalledTimes(38);
  });
  it('silently reaches the authoritative pause tick across scheduled and unsent frames without reviving attacks', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 100 });
    const tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0.2, frames: [
      { tick: 101, start: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.shot], stop: [] },
      { tick: 102, start: [CUE.enemyEngine], stop: [] },
    ] });
    send(processor, { type: 'pause', generation: 1, paused: true, reason: 'focus', tick: 104, frames: [
      { tick: 103, start: [CUE.countPulse, CUE.countNoise], stop: [CUE.enemyEngine] },
      { tick: 104, start: [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle],
        stop: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2] },
    ], start: [CUE.playerEngine, CUE.shot], stop: [] });
    expect(tick).toHaveBeenCalledTimes(4);
    for (const id of [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle, CUE.playerEngine]) expect(processor.driver.active(id)).toBe(true);
    for (const id of [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.enemyEngine, CUE.shot, CUE.countPulse, CUE.countNoise]) expect(processor.driver.active(id)).toBe(false);
    expect(render(processor, 4410).every(value => value === 0)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(4);
    send(processor, { type: 'pause', generation: 1, paused: false, reason: 'manual', tick: 104, frames: [], start: [], stop: [] });
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: current / 44100,
      frames: [{ tick: 105, start: [], stop: [] }] });
    expect(render(processor, 3000).some(value => Math.abs(value) > 0.02)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(processor.driver.active(CUE.shot)).toBe(false);
  });
  it('skips silent sample synthesis only after the final hardware frame and a finite filter tail', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 80 });
    const sample = vi.spyOn(processor.synth, 'sample'), silence = vi.spyOn(processor.synth, 'advanceSilence');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [
      { tick: 81, start: [], stop: [] }, { tick: 82, start: [], stop: [] }, { tick: 83, start: [], stop: [] },
    ] });
    expect(render(processor, 2500).every(value => value === 0)).toBe(true);
    expect(sample).not.toHaveBeenCalled(); expect(silence).toHaveBeenCalled();
    send(processor, { type: 'frames', generation: 1, sequence: 2, at: current / 44100, frames: [
      { tick: 84, start: [CUE.countPulse, CUE.countNoise], stop: [] },
      { tick: 85, start: [], stop: [] }, { tick: 86, start: [], stop: [] },
    ] });
    const pcm = render(processor, 6000);
    expect(pcm.subarray(750, 1400).some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(pcm.subarray(1500, 1700).some(value => Math.abs(value) > 0.00001)).toBe(true);
    expect(pcm.subarray(5000).every(value => value === 0)).toBe(true);
    const calls = sample.mock.calls.length;
    expect(calls).toBeGreaterThan(1400); expect(calls).toBeLessThan(5500);
    expect(render(processor, 4096).every(value => value === 0)).toBe(true);
    expect(sample).toHaveBeenCalledTimes(calls);
  });
});


describe('coalesced receiver acknowledgements', () => {
  it('reports reception and consumption once for a real frame consumed in the next quantum', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames: [{ tick: 1, start: [], stop: [] }] });
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    render(processor, 128);
    expect(processor.port.postMessage.mock.calls.map(call => call[0])).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 12, nextAt: 1 / AUDIO_TICK_HZ },
    ]);
    render(processor, 128);
    expect(processor.port.postMessage).toHaveBeenCalledOnce();
  });
  it('acknowledges a future frame at the next process even when no command was consumed', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 1, frames: [{ tick: 1, start: [], stop: [] }] });
    expect(acknowledgements(processor)).toEqual([]);
    render(processor, 128);
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 11, nextAt: 1 },
    ]);
    expect(progress(processor)).toEqual([]);
    render(processor, 44100);
    expect(progress(processor).at(-1)).toMatchObject({ sequence: 1, credits: 12 });
  });
  it('acknowledges accepted reception at a process with no output channel', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 1, frames: [{ tick: 1, start: [], stop: [] }] });
    expect(acknowledgements(processor)).toEqual([]);
    expect(processor.process([], [])).toBe(true);
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: 1, accepted: true, credits: 11, nextAt: 1 },
    ]);
  });
  it.each(['duplicate', 'empty proof'] as const)('keeps the zero-credit wakeup after an immediate %s ACK supersedes deferred reception', barrier => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    const frames = Array.from({ length: 12 }, (_, index) => ({ tick: index + 1, start: [], stop: [] }));
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0, frames });
    processor.port.postMessage.mockClear();
    send(processor, { type: 'frames', generation: 1, sequence: barrier === 'duplicate' ? 1 : 2, at: 0,
      frames: barrier === 'duplicate' ? frames : [] });
    expect(acknowledgements(processor)).toEqual([
      { type: 'ack', generation: 1, sequence: barrier === 'duplicate' ? 1 : 2, accepted: true, credits: 0 },
    ]);
    render(processor, 128);
    expect(progress(processor)).toEqual([
      { type: 'progress', generation: 1, sequence: barrier === 'duplicate' ? 1 : 2, credits: 1, nextAt: 1 / AUDIO_TICK_HZ },
    ]);
  });
  it.each(['reset', 'pause'] as const)('discards a deferred reception ACK at the real %s barrier', barrier => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 0 });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 1, frames: [{ tick: 1, start: [], stop: [] }] });
    expect(acknowledgements(processor)).toEqual([]);
    if (barrier === 'reset') send(processor, { type: 'reset', generation: 2, start: [], offset: 0, tick: 1 });
    else send(processor, { type: 'pause', generation: 1, paused: true, reason: 'focus', tick: 1, frames: [], start: [], stop: [] });
    render(processor, 128);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });
});


describe('fresh unsent attacks across overflow recovery', () => {
  const rate = 44100, frameSamples = rate / AUDIO_TICK_HZ;
  it.each([
    [0, true], [Math.floor(2 * frameSamples), true], [Math.ceil(2 * frameSamples), false], [-1, false],
  ] as const)('checks original recovery age %s samples at its actual decode', (age, accepted) => {
    current = 10000; vi.stubGlobal('currentFrame', current);
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: (current - age) / rate, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: current / rate,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    const pcm = render(processor, 3000);
    expect(trigger.mock.calls.map(call => call[0])).toEqual(accepted ? [CUE.shot] : []);
    expect(pcm.some(value => Math.abs(value) > 0.02)).toBe(accepted);
    expect(tick).toHaveBeenCalledTimes(2);
  });
  it('expires recovery that was fresh at reset but waits too long for its first real step', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    expect(render(processor, 2000).every(value => value === 0)).toBe(true);
    expect(tick).not.toHaveBeenCalled(); expect(trigger).not.toHaveBeenCalled();
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: current / rate,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    expect(render(processor, 3000).every(value => value === 0)).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); expect(tick).toHaveBeenCalledTimes(2);
  });
  it.each(['paired unpause', 'manual pause', 'focus pause'] as const)('handles the %s barrier before recovery consumption', barrier => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger');
    const reason = barrier === 'focus pause' ? 'focus' : 'manual';
    if (barrier !== 'paired unpause') send(processor, { type: 'pause', generation: 1,
      paused: true, reason, tick: 20, frames: [], start: [], stop: [] });
    send(processor, { type: 'pause', generation: 1, paused: false, reason, tick: 20, frames: [], start: [], stop: [] });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    const pcm = render(processor, 3000);
    expect(trigger.mock.calls.map(call => call[0])).toEqual(barrier === 'paired unpause' ? [CUE.shot] : []);
    expect(pcm.some(value => Math.abs(value) > 0.02)).toBe(barrier === 'paired unpause');
  });
  it.each(['older reset', 'new reset', 'capacity rejection'] as const)('does not retain incorrect recovery after %s', barrier => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 2, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger');
    if (barrier === 'capacity rejection') send(processor, { type: 'frames', generation: 2, sequence: 1, at: 0,
      frames: Array.from({ length: 13 }, (_, index) => ({ tick: 21 + index, start: [], stop: [] })) });
    else send(processor, { type: 'reset', generation: barrier === 'older reset' ? 1 : 3, start: [], offset: 0, tick: 20 });
    const generation = barrier === 'new reset' ? 3 : 2;
    send(processor, { type: 'frames', generation, sequence: 2, at: 0,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    const pcm = render(processor, 3000);
    expect(trigger.mock.calls.map(call => call[0])).toEqual(barrier === 'older reset' ? [CUE.shot] : []);
    expect(pcm.some(value => Math.abs(value) > 0.02)).toBe(barrier === 'older reset');
  });
  it('consumes duplicated recovery IDs once, only on a genuinely advanced tick', () => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot, CUE.stagePulse1] }, { at: 0, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    const batch: AudioMessage = { type: 'frames', generation: 1, sequence: 1, at: 0,
      frames: [{ tick: 20, start: [], stop: [] }, { tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] };
    send(processor, batch); send(processor, batch);
    expect(render(processor, 3000).some(value => Math.abs(value) > 0.02)).toBe(true);
    send(processor, batch); render(processor, 1000);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot); expect(tick).toHaveBeenCalledTimes(2);
  });
  it.each([0.02, 0.2])('rechecks recovery when the first command is scheduled at %s seconds', at => {
    const processor = new ProcessorType();
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger');
    send(processor, { type: 'frames', generation: 1, sequence: 1, at,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    const pcm = render(processor, Math.ceil(at * rate) + 3000);
    expect(trigger.mock.calls.map(call => call[0])).toEqual(at === 0.02 ? [CUE.shot] : []);
    expect(pcm.some(value => Math.abs(value) > 0.02)).toBe(at === 0.02);
  });
  it.each([0, 1])('does not rearm consumed recovery after a duplicate generation %i reset', generation => {
    const processor = new ProcessorType();
    const reset: AudioMessage = { type: 'reset', generation, start: [], offset: 0, tick: 20,
      recovery: [{ at: 0, start: [CUE.shot] }] };
    send(processor, reset);
    const trigger = vi.spyOn(processor.driver, 'trigger');
    send(processor, { type: 'frames', generation, sequence: 1, at: 0,
      frames: [{ tick: 21, start: [], stop: [] }] });
    render(processor, 1); vi.stubGlobal('currentFrame', current);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot);
    send(processor, reset);
    send(processor, { type: 'frames', generation, sequence: 2, at: current / rate,
      frames: [{ tick: 21, start: [], stop: [] }, { tick: 22, start: [], stop: [] }] });
    expect(render(processor, 3000).every(value => value === 0)).toBe(true);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot);
  });
  it('retains a recovered tally note for a complete hardware frame without reviving expired ordinary starts', () => {
    const processor = new ProcessorType(); render(processor, 1000); vi.stubGlobal('currentFrame', current);
    send(processor, { type: 'reset', generation: 1, start: [], offset: 0, tick: 20,
      recovery: [{ at: current / rate, start: [CUE.countPulse, CUE.countNoise] }] });
    const trigger = vi.spyOn(processor.driver, 'trigger'), tick = vi.spyOn(processor.driver, 'tick');
    const writes: { frame: number; channel: number; register: number; value: number }[] = [];
    const write = processor.synth.write.bind(processor.synth);
    vi.spyOn(processor.synth, 'write').mockImplementation((channel, register, value) => {
      writes.push({ frame: current, channel, register, value }); write(channel, register, value);
    });
    send(processor, { type: 'frames', generation: 1, sequence: 1, at: -1,
      frames: [{ tick: 21, start: [CUE.shot], stop: [] }, { tick: 22, start: [], stop: [] },
        { tick: 23, start: [], stop: [] }, { tick: 24, start: [], stop: [] }] });
    const pcm = render(processor, 4000, 1);
    expect(trigger).toHaveBeenCalledWith(CUE.countPulse); expect(trigger).toHaveBeenCalledWith(CUE.countNoise);
    expect(trigger).not.toHaveBeenCalledWith(CUE.shot);
    const note = writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x80)!;
    const mute = writes.find(event => event.channel === 1 && event.register === 0 && event.value === 0x10 && note && event.frame > note.frame)!;
    expect(note.frame).toBe(1000 + Math.ceil(frameSamples));
    expect(mute.frame - note.frame).toBeGreaterThanOrEqual(frameSamples);
    expect(pcm.some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(pcm.subarray(3500).every(value => Math.abs(value) < 0.0001)).toBe(true);
    expect(tick).toHaveBeenCalledTimes(4);
  });
});
