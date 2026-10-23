import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameAudio } from '../../src/platform/audio';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';
import { SCORE_TIMING } from '../../src/game/score-timeline';
import type { AudioMessage } from '../../src/platform/audio-protocol';
import { processorFixture } from './audio-processor-fixture';
import { Context, Node, installNativeAudio, settle } from './native-audio-fixture';

async function enabled(clock?: () => number) {
  const audio = new GameAudio(0.3, clock); audio.unlock(); await settle();
  return { audio, context: Context.instances[0], node: Node.instances[0] };
}
function fixture() {
  const state = new GameEngine(getLevel(1), { stage: 1, mode: 'single', seed: 1 }).state;
  state.phase = 'playing'; state.tanks[0].spawnTicks = 0; return state;
}
function cues(node: Node): number[] {
  return node.messages.flatMap(message => message.type === 'commands' ? message.commands.filter(command => command.start).map(command => command.id) : []);
}
const shot = { type: 'fire' as const, team: 'player' as const, playerIndex: 0 as const, enemyKind: null, stars: 0 };
beforeEach(installNativeAudio);
afterEach(() => vi.unstubAllGlobals());
describe('semantic game audio and recovery', () => {
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
    ]); audio.commitFrame();
    expect(cues(node)).toEqual([15, 12, 13, 14, 10, 11, 7, 9, 6, 4, 5]);
    const previous = cues(node).length;
    audio.play([
      { type: 'hit', target: 'tank', team: 'player', playerIndex: 0, tankTeam: 'player', targetPlayerIndex: 1, gunSlot: 0 },
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0, gunSlot: 8, steelPower: false },
      { type: 'hit', target: 'brick', team: 'enemy', playerIndex: null, gunSlot: 2, steelPower: false },
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0, gunSlot: 8, steelPower: true },
    ]); audio.commitFrame();
    expect(cues(node).slice(previous)).toEqual([CUE.brick]);
  });
  it('shares score count timing, deduplicates counts, and discards paused counts on resume', async () => {
    const { audio, node } = await enabled(); const state = fixture(); state.phase = 'lost'; state.players[0].kills = [2, 0, 0, 0];
    const count1 = SCORE_TIMING.leadMs + SCORE_TIMING.countMs;
    audio.updateScore(state, count1); audio.commitFrame();
    audio.updateScore(state, count1); audio.commitFrame();
    expect(cues(node)).toEqual([19, 20]);
    audio.setPaused(true); audio.updateScore(state, count1 + SCORE_TIMING.countMs); audio.commitFrame();
    audio.setPaused(false); audio.updateScore(state, count1 + SCORE_TIMING.countMs); audio.commitFrame();
    expect(cues(node)).toEqual([19, 20]);
    audio.updateScore(state, 5000); audio.commitFrame(); expect(cues(node)).toEqual([19, 20]);
  });
  it('keeps zero-kill tally and loss-entry silent, starting melodies only on their presentation pages', async () => {
    const { audio, node } = await enabled(); const state = fixture(); state.phase = 'lost';
    audio.play([{ type: 'game-over' }]); audio.updateScore(state, 6000); audio.commitFrame();
    expect(cues(node)).toEqual([]);
    audio.startPresentation('gameover'); audio.commitFrame();
    expect(cues(node)).toEqual([24, 25, 26]);
    audio.stopScene(); audio.startPresentation('hiscore'); audio.commitFrame();
    expect(cues(node).slice(-3)).toEqual([21, 22, 23]);
  });
  it('only cues the cooperative 1000-point award for a winning unequal tally', async () => {
    const { audio, node } = await enabled(); const state = new GameEngine(getLevel(1), { stage: 1, mode: 'coop' }).state;
    state.players[0].kills = [1, 0, 0, 0]; state.phase = 'lost';
    audio.updateScore(state, 6000); audio.commitFrame(); expect(cues(node)).not.toContain(27);
    audio.stopScene(); state.phase = 'won'; audio.updateScore(state, 6000); audio.commitFrame();
    audio.updateScore(state, 7000); audio.commitFrame(); expect(cues(node).filter(id => id === 27)).toHaveLength(1);
  });
  it('switches engines only on semantic changes and never retriggers an already started intro', async () => {
    const { audio, node } = await enabled(); const state = fixture(); state.phase = 'intro';
    for (let index = 0; index < 10; index++) { audio.syncState(state); audio.play([{ type: 'stage-start' }]); audio.commitFrame(); }
    expect(cues(node)).toEqual([1, 2, 3]); state.phase = 'playing';
    for (let index = 0; index < 10; index++) { state.tick++; audio.syncState(state); audio.commitFrame(); }
    expect(cues(node).slice(3)).toEqual([CUE.enemyEngine]);
    state.tanks[0].moving = true; state.tick++; audio.syncState(state); audio.commitFrame();
    expect(cues(node).at(-1)).toBe(CUE.playerEngine);
  });
  it.each(['manual', 'focus'] as const)('uses explicit %s control and gates only focus recovery without resuming the context', async reason => {
    const { audio, context, node } = await enabled(); audio.setPaused(true, reason);
    expect(node.messages.at(-1)).toMatchObject({ type: 'pause', paused: true, reason });
    expect(context.gain.gain.value).toBe(reason === 'focus' ? 0 : 0.3); audio.setPaused(false);
    const resume = node.messages.at(-1) as Extract<AudioMessage, { type: 'pause' }>;
    expect(resume).toMatchObject({ type: 'pause', paused: false });
    expect(resume.confirm).toBe(reason === 'focus' ? true : undefined);
    expect(context.gain.gain.value).toBe(reason === 'focus' ? 0 : 0.3);
    if (reason === 'focus') node.port.onmessage!({ data: {
      type: 'control-applied', generation: resume.generation, sequence: resume.sequence,
    } });
    expect(context.gain.gain.value).toBe(0.3); expect(context.resume).not.toHaveBeenCalled();
  });
  it.each(['load-first', 'resume-first'] as const)('recovers the current music at active elapsed time with %s completion', async order => {
    let now = 0, finishLoad!: () => void, finishResume!: () => void;
    Context.initialState = 'suspended'; Context.load = () => new Promise<void>(resolve => { finishLoad = resolve; });
    Context.resume = context => new Promise<void>(resolve => { finishResume = () => { context.state = 'running'; resolve(); }; });
    const audio = new GameAudio(0.3, () => now); audio.unlock(); audio.play([{ type: 'stage-start' }, shot]);
    now = 1200;
    if (order === 'load-first') { finishLoad(); await settle(); finishResume(); } else { finishResume(); await settle(); finishLoad(); }
    await settle(); const node = Node.instances[0];
    expect(node.messages.at(-1)).toMatchObject({ type: 'reset', music: [1, 2, 3], offset: Math.floor(1.2 * AUDIO_TICK_HZ), paused: false });
    expect(cues(node)).toEqual([]); expect(Context.instances).toHaveLength(1);
    const previous = node.messages.length; audio.unlock(); await settle(); expect(node.messages).toHaveLength(previous);
  });
  it.each(['manual', 'focus'] as const)('excludes %s pause time when restoring a suspended context', async reason => {
    let now = 0; const { audio, node, context } = await enabled(() => now);
    audio.play([{ type: 'stage-start' }]); audio.commitFrame(); now = 100; audio.setPaused(true, reason);
    now = 2100; context.state = 'suspended'; audio.unlock(); await settle();
    expect(node.messages.at(-1)).toMatchObject({ type: 'reset', offset: 6, paused: true, reason });
    audio.setPaused(false); now = 2200; context.state = 'suspended'; audio.unlock(); await settle();
    expect(node.messages.at(-1)).toMatchObject({ type: 'reset', offset: 12, paused: false });
  });
  it('recovers only the latest finite song and engine after failure, excluding stale shots and expired music', async () => {
    let now = 0; Context.load = () => Promise.reject(new Error('load failed'));
    const audio = new GameAudio(0.3, () => now); audio.unlock(); await settle();
    audio.startPresentation('gameover'); now = 200; audio.stopScene(); audio.startPresentation('hiscore'); audio.play([shot]);
    Context.load = () => Promise.resolve(); now = 1200; audio.unlock(); await settle();
    const node = Node.instances[0]; expect(Context.instances[0].close).toHaveBeenCalledOnce();
    expect(node.messages.at(-1)).toMatchObject({ type: 'reset', music: [21, 22, 23], offset: 60 }); expect(cues(node)).toEqual([]);
    audio.syncState(fixture()); audio.commitFrame(); now = 10000;
    Context.instances[1].state = 'suspended'; audio.unlock(); await settle();
    expect(node.messages.at(-1)).toMatchObject({ type: 'reset', music: [], offset: 0, engine: CUE.enemyEngine });
  });
  it('does not revive a cleared scene or an old attack after loading or disposal', async () => {
    let finish!: () => void; Context.load = () => new Promise<void>(resolve => { finish = resolve; });
    const audio = new GameAudio(0.3); audio.unlock(); audio.play([{ type: 'stage-start' }, shot]); audio.setPaused(true);
    audio.stopScene(); finish(); await settle();
    expect(Node.instances[0].messages.at(-1)).toMatchObject({ type: 'reset', music: [], engine: null, paused: false });
    const node = Node.instances[0]; const done = audio.dispose(); expect(audio.dispose()).toBe(done); await done;
    audio.play([shot]); audio.commitFrame(); audio.unlock();
    expect(node.port.close).toHaveBeenCalledOnce(); expect(Context.instances[0].gain.gain.value).toBe(0);
    expect(cues(node)).toEqual([]);
  });
  it.each([44100, 48000].flatMap(rate => [[80, 30], [100.1, 0], [300, 0]].map(([sender, delivery]) => [rate, sender, delivery])))
    ('plays one shot at %i Hz after %s ms sender and %s ms delivery delays', async (rate, sender, delivery) => {
    const receiver = await processorFixture(rate);
    const { audio, node, context } = await enabled(() => receiver.now() * 1000);
    for (const message of node.messages) receiver.send(message);
    const delivered = node.messages.length;
    audio.play([shot]);
    receiver.render(Math.round(rate * sender / 1000)); context.currentTime = receiver.now();
    audio.commitFrame();
    receiver.render(Math.round(rate * delivery / 1000)); context.currentTime = receiver.now();
    const trigger = vi.spyOn(receiver.processor.driver, 'trigger');
    for (const message of node.messages.slice(delivered)) receiver.send(message);
    expect(receiver.render(Math.round(rate * 0.3)).some(value => Math.abs(value) > 0.002)).toBe(true);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(CUE.shot);
    audio.commitFrame();
    expect(cues(node)).toEqual([CUE.shot]);
  });
  it.each([150, 300])('starts real driver/synth PCM while the main thread does nothing for %i ms', async ms => {
    const receiver = await processorFixture(); const { audio, node, context } = await enabled(() => 0);
    let delivered = 0;
    const deliver = () => { for (const message of node.messages.slice(delivered)) receiver.send(message); delivered = node.messages.length; };
    audio.play([{ type: 'stage-start' }]); audio.commitFrame(); deliver();
    const pcm = receiver.render(Math.round(ms * receiver.rate / 1000));
    const onset = pcm.findIndex(value => Math.abs(value * context.gain.gain.value) > 0.002) / receiver.rate;
    expect(onset).toBeGreaterThan(0); expect(onset).toBeLessThan(0.09);
    expect(pcm.slice(Math.floor(receiver.rate * 0.1)).some(value => Math.abs(value) > 0.02)).toBe(true);
    expect(receiver.processor.port.postMessage).not.toHaveBeenCalled();
  });
});
