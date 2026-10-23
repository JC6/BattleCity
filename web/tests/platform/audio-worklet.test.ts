import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';
import { processorFixture } from './audio-processor-fixture';
afterEach(() => vi.unstubAllGlobals());
const intro = [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2];
const audible = (pcm: Float32Array) => pcm.some(value => Math.abs(value) > 0.002);

describe('sample-clock APU playback', () => {
  it.each([44100, 48000].flatMap(rate => [64, 128, 256].map(quantum => [rate, quantum])))('plays an entire phrase at %i Hz with %i-sample blocks after one command', async (rate, quantum) => {
    const { processor, send, render } = await processorFixture(rate);
    const tick = vi.spyOn(processor.driver, 'tick');
    send({ type: 'commands', generation: 1, sequence: 1,
      commands: intro.map(id => ({ id, start: true })) });
    const pcm = render(rate * 5, quantum), frame = rate / AUDIO_TICK_HZ;
    expect(pcm.subarray(0, Math.ceil(frame)).every(value => value === 0)).toBe(true);
    expect(audible(pcm.subarray(Math.ceil(frame), rate / 5))).toBe(true);
    expect(audible(pcm.subarray(rate * 3, rate * 4))).toBe(true);
    expect(pcm.subarray(Math.ceil(rate * 4.6)).every(value => value === 0)).toBe(true);
    for (const id of intro) expect(processor.driver.active(id)).toBe(false);
    // Includes the hardware mute and bounded filter tail, never game callbacks.
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(266);
    expect(tick.mock.calls.length).toBeLessThan(273);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });
  it.each([44100, 48000].flatMap(rate => [99, 100, 100.1, 110, 150, 300].map(delay => [rate, delay])))
    ('plays delayed attacks once with a full first frame at %i Hz after %s ms', async (rate, delay) => {
    const { processor, send, render, now } = await processorFixture(rate);
    const message = { type: 'commands' as const, generation: 1, sequence: 1,
      commands: [CUE.countPulse, CUE.countNoise, CUE.shot].map(id => ({ id, start: true })) };
    render(Math.round(rate * delay / 1000));
    const trigger = vi.spyOn(processor.driver, 'trigger');
    const writes: { at: number; value: number }[] = [], write = processor.synth.write.bind(processor.synth);
    vi.spyOn(processor.synth, 'write').mockImplementation((channel, register, value) => {
      if (channel === 1 && register === 0) writes.push({ at: now() * rate, value });
      write(channel, register, value);
    });
    send(message);
    expect(audible(render(Math.ceil(rate * 0.14), 1))).toBe(true);
    expect(trigger.mock.calls.map(call => call[0])).toEqual([CUE.countPulse, CUE.countNoise, CUE.shot]);
    const note = writes.find(event => event.value === 0x80)!;
    const mute = writes.find(event => event.value === 0x10 && event.at > note.at)!;
    expect(mute.at - note.at).toBeCloseTo(Math.ceil(rate / AUDIO_TICK_HZ), 6);
    render(Math.ceil(rate / 2)); // Finish the attack and tail before duplicate delivery.
    trigger.mockClear(); send(message);
    expect(audible(render(6000))).toBe(false); expect(trigger).not.toHaveBeenCalled();
  });
  it.each([44100, 48000])('keeps a received attack until the next ordinary tick at %i Hz', async rate => {
    const { processor, send, render } = await processorFixture(rate);
    render(Math.round(rate * 0.01));
    send({ type: 'reset', generation: 2, music: [], offset: 0, engine: CUE.enemyEngine, paused: false, reason: 'manual' });
    render(Math.round(rate * 0.098));
    const trigger = vi.spyOn(processor.driver, 'trigger');
    send({ type: 'commands', generation: 2, sequence: 1,
      commands: [{ id: CUE.shot, start: true }] });
    expect(trigger).not.toHaveBeenCalled();
    render(Math.round(rate * 0.020));
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot);
  });
  it.each([150, 300])('continues the same music through a %i ms main-thread stall without replies', async ms => {
    const { processor, send, render, rate } = await processorFixture();
    send({ type: 'commands', generation: 1, sequence: 1, commands: intro.map(id => ({ id, start: true })) });
    const tick = vi.spyOn(processor.driver, 'tick'), length = Math.round(rate * ms / 1000);
    const pcm = render(length);
    expect(audible(pcm.subarray(Math.ceil(rate / AUDIO_TICK_HZ)))).toBe(true);
    expect(tick).toHaveBeenCalledTimes(Math.ceil(ms * AUDIO_TICK_HZ / 1000));
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });
  it.each(['manual', 'focus'] as const)('freezes music and its fractional phase during %s pause', async reason => {
    const { processor, send, render } = await processorFixture();
    send({ type: 'commands', generation: 1, sequence: 1, commands: intro.map(id => ({ id, start: true })) });
    render(3000); const remaining = processor.remaining, tick = vi.spyOn(processor.driver, 'tick');
    send({ type: 'pause', generation: 1, sequence: 2, paused: true, reason, commands: [] });
    const paused = render(44100);
    expect(audible(paused.subarray(0, 22050))).toBe(reason === 'manual');
    expect(paused.subarray(30000).every(value => value === 0)).toBe(true);
    expect(tick).not.toHaveBeenCalled(); expect(processor.remaining).toBe(remaining);
    send({ type: 'commands', generation: 1, sequence: 3, commands: [{ id: CUE.shot, start: true }] });
    send({ type: 'pause', generation: 1, sequence: 4, paused: false, reason, commands: [] });
    expect(audible(render(4410))).toBe(true); expect(processor.driver.active(CUE.shot)).toBe(false);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(7);
  });
  it.each(['pending', 'playing'] as const)('discards a %s shot across a pause without a resumed fragment', async state => {
    const { send, render } = await processorFixture();
    send({ type: 'commands', generation: 1, sequence: 1, commands: [{ id: CUE.shot, start: true }] });
    if (state === 'playing') expect(audible(render(2000))).toBe(true);
    send({ type: 'pause', generation: 1, sequence: 2, paused: true, reason: 'focus', commands: [] }); render(4410);
    send({ type: 'pause', generation: 1, sequence: 3, paused: false, reason: 'manual', commands: [] });
    // Filters can retain a decaying old sample after a hardware mute.
    expect(render(6000).every(value => value === 0)).toBe(true);
  });
  it('preserves music paused before its first decode and rejects duplicate pause/reset controls', async () => {
    const { processor, send, render } = await processorFixture();
    const pause = { type: 'pause' as const, generation: 1, sequence: 1, paused: true, reason: 'focus' as const,
      commands: intro.map(id => ({ id, start: true })) };
    send(pause); render(44100); send(pause);
    const tick = vi.spyOn(processor.driver, 'tick');
    send({ type: 'pause', generation: 1, sequence: 2, paused: false, reason: 'manual', commands: [] });
    expect(audible(render(4410))).toBe(true); expect(tick).toHaveBeenCalledTimes(7);
    send({ type: 'reset', generation: 2, music: [], offset: 0, engine: null, paused: false, reason: 'manual' });
    send(pause); send({ type: 'reset', generation: 2, music: intro, offset: 0, engine: null, paused: false, reason: 'manual' });
    expect(render(6000).every(value => value === 0)).toBe(true);
  });
  it('merges changes by slot, using the final operation and the original note priority', async () => {
    const { processor, send, render } = await processorFixture(); const trigger = vi.spyOn(processor.driver, 'trigger');
    send({ type: 'commands', generation: 1, sequence: 1, commands: [CUE.playerEngine, CUE.shot].map(id => ({ id, start: true })) });
    send({ type: 'commands', generation: 1, sequence: 2, commands: [{ id: CUE.playerEngine, start: false },
      { id: CUE.enemyEngine, start: true }] });
    render(2205);
    expect(trigger.mock.calls.map(call => call[0])).toEqual([CUE.shot, CUE.enemyEngine]);
    expect(processor.driver.active(CUE.playerEngine)).toBe(false);
  });
  it('seeks recovered music without seeking a newly selected engine and resets manual pause atomically', async () => {
    const { processor, send, render } = await processorFixture();
    send({ type: 'reset', generation: 2, music: intro, offset: 100, engine: CUE.enemyEngine, paused: true, reason: 'manual' });
    const tick = vi.spyOn(processor.driver, 'tick'); expect(audible(render(4410))).toBe(true); expect(tick).not.toHaveBeenCalled();
    send({ type: 'reset', generation: 3, music: [], offset: 0, engine: null, paused: false, reason: 'manual' });
    expect(render(4410).every(value => value === 0)).toBe(true);
  });
  it('confirms pause controls only after clearing attacks and applying the new pause state', async () => {
    const { processor, send, render } = await processorFixture();
    send({ type: 'commands', generation: 1, sequence: 1,
      commands: [...intro, CUE.shot].map(id => ({ id, start: true })) });
    expect(audible(render(3000))).toBe(true);
    const remaining = processor.remaining;
    processor.port.postMessage.mockImplementationOnce(reply => {
      expect(reply).toEqual({ type: 'control-applied', generation: 1, sequence: 2 });
      expect(processor.driver.active(CUE.shot)).toBe(false);
      expect(render(4410).every(value => value === 0)).toBe(true);
      expect(processor.remaining).toBe(remaining);
    });
    send({ type: 'pause', generation: 1, sequence: 2, paused: true, reason: 'focus', commands: [], confirm: true });
    processor.port.postMessage.mockImplementationOnce(reply => {
      expect(reply).toEqual({ type: 'control-applied', generation: 1, sequence: 3 });
      expect(audible(render(4410))).toBe(true);
      expect(processor.driver.active(CUE.shot)).toBe(false);
    });
    send({ type: 'pause', generation: 1, sequence: 3, paused: false, reason: 'manual', commands: [], confirm: true });
    send({ type: 'commands', generation: 1, sequence: 4, commands: [] });
    expect(processor.port.postMessage).toHaveBeenCalledTimes(2);
  });
  it('confirms reset at sequence zero only after restoring state and applying focus silence', async () => {
    const { processor, send, render } = await processorFixture();
    send({ type: 'commands', generation: 1, sequence: 10,
      commands: [{ id: CUE.shot, start: true }] });
    expect(audible(render(2000))).toBe(true);
    processor.port.postMessage.mockImplementationOnce(reply => {
      expect(reply).toEqual({ type: 'control-applied', generation: 2, sequence: 0 });
      expect(processor.driver.active(CUE.shot)).toBe(false);
      for (const id of [...intro, CUE.enemyEngine]) expect(processor.driver.active(id)).toBe(true);
      expect(render(4410).every(value => value === 0)).toBe(true);
    });
    send({ type: 'reset', generation: 2, music: intro, offset: 100, engine: CUE.enemyEngine,
      paused: true, reason: 'focus', confirm: true });
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
  });
  it('does not confirm rejected generations, duplicate controls or superseded sequences', async () => {
    const { processor, send } = await processorFixture();
    const pause = { type: 'pause' as const, generation: 1, sequence: 3, paused: true,
      reason: 'focus' as const, commands: [], confirm: true };
    const reset = { type: 'reset' as const, generation: 2, music: [], offset: 0, engine: null,
      paused: false, reason: 'manual' as const, confirm: true };
    send(pause); send(pause); send({ ...pause, sequence: 2 });
    send({ ...pause, generation: 0, sequence: 4 }); send({ ...pause, generation: 2, sequence: 4 });
    send({ ...reset, generation: 0 }); send({ ...reset, generation: 1 });
    send(reset); send(reset); send({ ...pause, sequence: 4 });
    send({ type: 'commands', generation: 2, sequence: 5, commands: [] });
    send({ ...pause, generation: 2, sequence: 4 }); send({ ...pause, generation: 2, sequence: 5 });
    expect(processor.port.postMessage.mock.calls).toEqual([
      [{ type: 'control-applied', generation: 1, sequence: 3 }],
      [{ type: 'control-applied', generation: 2, sequence: 0 }],
    ]);
  });
  it.each([44100, 48000].flatMap(rate => [64, 128, 256].map(quantum => [rate, quantum])))('control confirmations preserve exact PCM at %i Hz with %i-sample blocks', async (rate, quantum) => {
    async function playback(confirm: boolean) {
      const { processor, send, render } = await processorFixture(rate);
      const chunks: Float32Array[] = [];
      const capture = (samples: number) => chunks.push(render(samples, quantum));
      send({ type: 'reset', generation: 2, music: intro, offset: 0, engine: CUE.playerEngine,
        paused: false, reason: 'manual', confirm }); capture(2000);
      send({ type: 'commands', generation: 2, sequence: 1,
        commands: [{ id: CUE.shot, start: true }] }); capture(777);
      send({ type: 'pause', generation: 2, sequence: 2, paused: true, reason: 'focus', commands: [], confirm }); capture(1000);
      send({ type: 'pause', generation: 2, sequence: 3, paused: false, reason: 'manual', commands: [], confirm }); capture(777);
      send({ type: 'pause', generation: 2, sequence: 4, paused: true, reason: 'manual', commands: [], confirm }); capture(rate);
      send({ type: 'pause', generation: 2, sequence: 5, paused: false, reason: 'manual', commands: [], confirm }); capture(1000);
      send({ type: 'reset', generation: 3, music: [], offset: 0, engine: null,
        paused: false, reason: 'manual', confirm }); capture(1000);
      expect(processor.port.postMessage).toHaveBeenCalledTimes(confirm ? 6 : 0);
      return chunks;
    }
    const baseline = await playback(false), confirmed = await playback(true);
    for (let i = 0; i < baseline.length; i++) {
      expect(Buffer.from(confirmed[i].buffer).equals(Buffer.from(baseline[i].buffer))).toBe(true);
    }
  });
});
