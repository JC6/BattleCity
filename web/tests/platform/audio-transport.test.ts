import { describe, expect, it, vi } from 'vitest';
import { AudioTransport, type AudioEndpoint } from '../../src/platform/audio-transport';
import type { AudioMessage, PersistentAudio } from '../../src/platform/audio-protocol';
import type { AudioRuntimeHooks } from '../../src/platform/audio-runtime';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';
function fixture(volume = 0.3) {
  const messages: AudioMessage[] = [], persistent: PersistentAudio = { music: [], offset: 0, engine: null };
  let now = 0, hooks!: AudioRuntimeHooks;
  const endpoint: AudioEndpoint = { status: 'ready', connected: true, ready: true, get now() { return now; },
    unlock: vi.fn(), setGain: vi.fn(), post: message => { messages.push(message); }, dispose: vi.fn(async () => {}) };
  const transport = new AudioTransport(volume, () => persistent, callbacks => { hooks = callbacks; return endpoint; });
  hooks.ready();
  const batches = () => messages.filter((message): message is Extract<AudioMessage, { type: 'commands' }> => message.type === 'commands');
  return { transport, endpoint, messages, persistent, hooks, batches, time: (value: number) => { now = value; } };
}
describe('semantic audio command transport', () => {
  it('submits the first attack without receiving a reply and never sends heartbeat frames', () => {
    const { transport, batches, messages, endpoint } = fixture();
    for (let index = 0; index < 100; index++) transport.commitFrame(); expect(messages).toHaveLength(1);
    transport.cue(CUE.stagePulse1); transport.commitFrame();
    expect(batches()).toHaveLength(1); expect(endpoint.setGain).toHaveBeenLastCalledWith(0.3);
    for (let index = 0; index < 100; index++) transport.commitFrame(); expect(messages).toHaveLength(2);
    for (let index = 0; index < 20; index++) { transport.cue(CUE.shot); transport.commitFrame(); }
    expect(batches()).toHaveLength(21); expect(messages.filter(message => message.type === 'reset')).toHaveLength(1);
  });
  it('coalesces each slot to its last operation and bounds pending commands by the track table', () => {
    const { transport, batches } = fixture();
    for (let index = 0; index < 100; index++) { transport.cue(CUE.shot); transport.stop(CUE.shot); }
    transport.cue(CUE.playerEngine); transport.stop(CUE.playerEngine); transport.cue(CUE.enemyEngine);
    transport.cue(100); transport.commitFrame();
    expect(batches()[0].commands).toEqual([
      { id: CUE.shot, start: false, createdAt: 0 }, { id: CUE.playerEngine, start: false, createdAt: 0 },
      { id: CUE.enemyEngine, start: true, createdAt: 0 },
    ]);
  });
  it.each([0.052, 0.087, 0.1, 0.101])('retains count creation time across a %s-second sender delay', delay => {
    const { transport, batches, time } = fixture();
    transport.cue(CUE.countPulse); transport.cue(CUE.countNoise); transport.cue(CUE.shot);
    transport.cue(CUE.stagePulse1); transport.stop(CUE.enemyEngine); time(delay); transport.commitFrame();
    const expected = delay <= 0.1 ? [CUE.countPulse, CUE.countNoise, CUE.stagePulse1] : [CUE.stagePulse1];
    expect(batches()[0].commands.filter(command => command.start).map(command => command.id)).toEqual(expected);
    expect(batches()[0].commands.every(command => command.createdAt === 0)).toBe(true);
    expect(batches()[0].sentAt).toBe(delay);
    expect(batches()[0].commands.at(-1)).toMatchObject({ id: CUE.enemyEngine, start: false });
  });
  it.each([2 / AUDIO_TICK_HZ, 2 / AUDIO_TICK_HZ + 0.0001])('uses the existing two-tick sender budget at %s seconds', delay => {
    const { transport, batches, time } = fixture(); transport.cue(CUE.shot); time(delay); transport.commitFrame();
    expect(batches()).toHaveLength(delay <= 2 / AUDIO_TICK_HZ ? 1 : 0);
  });
  it.each(['manual', 'focus'] as const)('preserves pending music but discards attacks across %s pause', reason => {
    const { transport, messages, batches, endpoint } = fixture();
    transport.cue(CUE.stagePulse1); transport.cue(CUE.shot); transport.setPaused(true, reason);
    expect(messages.at(-1)).toMatchObject({ type: 'pause', paused: true, reason,
      commands: [{ id: CUE.stagePulse1, start: true, createdAt: 0 }] });
    transport.cue(CUE.countPulse); transport.commitFrame(); transport.setPaused(false); transport.commitFrame();
    expect(batches()).toHaveLength(0); expect(endpoint.setGain).toHaveBeenLastCalledWith(0.3);
  });
  it.each(['ready', 'blocked', 'resumed'] as const)('restores only the latest semantic snapshot on %s, including while not running', hook => {
    const { transport, messages, persistent, hooks, endpoint, batches } = fixture();
    transport.cue(CUE.shot); persistent.music = [21, 22, 23]; persistent.offset = 65; persistent.engine = CUE.enemyEngine;
    transport.setPaused(true, 'focus'); Object.assign(endpoint, { ready: false }); hooks[hook]();
    expect(messages.at(-1)).toMatchObject({ type: 'reset', music: [21, 22, 23], offset: 65,
      engine: CUE.enemyEngine, paused: true, reason: 'focus' });
    Object.assign(endpoint, { ready: true }); transport.setPaused(false); transport.commitFrame(); expect(batches()).toHaveLength(0);
  });
  it('drops attacks while unavailable and clears pending commands across stop, failure and disposal', async () => {
    const { transport, batches, endpoint, hooks, messages } = fixture();
    Object.assign(endpoint, { ready: false }); transport.cue(CUE.shot); Object.assign(endpoint, { ready: true });
    transport.commitFrame(); expect(batches()).toHaveLength(0);
    transport.cue(CUE.shot); transport.stopScene(); transport.commitFrame();
    transport.cue(CUE.shot); hooks.failed(); hooks.ready(); transport.commitFrame();
    transport.cue(CUE.shot); await transport.dispose(); expect(endpoint.dispose).toHaveBeenCalledOnce();
    expect(batches()).toHaveLength(0); expect(messages.at(-1)).toMatchObject({ type: 'reset', music: [], engine: null });
  });
  it('keeps the first cue pending if the native gain setter fails', () => {
    const { transport, endpoint, batches } = fixture(); transport.cue(CUE.shot);
    vi.mocked(endpoint.setGain).mockImplementationOnce(() => { throw new Error('gain failed'); });
    expect(() => transport.commitFrame()).toThrow('gain failed'); expect(batches()).toHaveLength(0);
    transport.commitFrame(); expect(batches()[0].commands).toEqual([{ id: CUE.shot, start: true, createdAt: 0 }]);
  });
  it('never submits attacks with zero volume', () => {
    const { transport, batches } = fixture(0); transport.cue(CUE.shot); transport.commitFrame(); expect(batches()).toHaveLength(0);
  });
});
