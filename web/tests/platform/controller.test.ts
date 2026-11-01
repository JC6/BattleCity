import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../../src/app/controller';
import type { AppAudio, AppInput, AppRenderer, ArenaPresentation } from '../../src/app/ports';
import { EMPTY_INPUT } from '../../src/core/types';
import { TICK_MS } from '../../src/core/constants';
import { scoreTimeline } from '../../src/game/score-timeline';
import { INTRO_TICKS } from '../../src/core/rules';

function fixture() {
  const trace: string[] = [];
  const pad = { up: false, right: false, down: false, left: false, a: false, b: false, aPressed: false, bPressed: false };
  const input: AppInput = { read: vi.fn(() => [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }]),
    readPads: vi.fn(() => [{ ...pad }, { ...pad }]), clear: vi.fn(), resetForFocus: vi.fn() };
  const audio: AppAudio = { stopScene: vi.fn(() => trace.push('stop')), syncState: vi.fn(), play: vi.fn(),
    commitFrame: vi.fn(() => trace.push('commit')),
    updateScore: vi.fn(), startPresentation: vi.fn(), setPaused: vi.fn() };
  let presentation: ArenaPresentation = { kind: 'game' };
  const render: AppRenderer = { state: null, draft: null,
    get presentation() { return presentation; },
    set presentation(value) { presentation = value; trace.push(`present:${value.kind}`); }
 };
  let highScore = 20000;
  const seed = vi.fn(() => 7);
  const controller = new AppController({ input, audio, render, seed,
    records: { getHighScore: () => highScore, highScore: value => highScore = Math.max(highScore, value) } });
  return { controller, api: controller.testing!, audio, input, render, seed, trace, pad };
}
afterEach(() => vi.unstubAllGlobals());

describe('application controller ports', () => {
  it('starts and advances using injected ports with no browser globals', () => {
    vi.stubGlobal('window', undefined); vi.stubGlobal('document', undefined); vi.stubGlobal('crypto', undefined);
    const { controller, api, seed, trace } = fixture();
    controller.startKey(); controller.startKey();
    expect(api.state()!.tick).toBe(0);
    expect(trace.slice(-2)).toEqual(['commit', 'present:intro']);
    controller.frame(TICK_MS);
    expect(seed).toHaveBeenCalledOnce(); expect(api.state()).toMatchObject({ tick: 1, phase: 'intro', rng: 7 });
  });
  it('retains fractional fixed steps, caps stalled frames and submits audio before presentation', () => {
    const { controller, api, trace } = fixture(); api.start(); trace.length = 0;
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(0);
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(1);
    controller.frame(10000); expect(api.state()!.tick).toBe(7);
    expect(trace.slice(-2)).toEqual(['commit', 'present:intro']);
    controller.frame(-100); expect(api.state()!.tick).toBe(7);
  });
  it('drops inactive accumulated time and resumes only from explicit Start', () => {
    const { controller, api, input, audio } = fixture(); api.start();
    controller.frame(TICK_MS / 2); controller.inactive(); controller.frame(1000);
    expect(api.state()).toMatchObject({ tick: 0, phase: 'paused' });
    expect(input.resetForFocus).toHaveBeenCalledOnce(); expect(audio.setPaused).toHaveBeenLastCalledWith(true, 'focus');
    controller.startKey(); controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(0);
    controller.frame(TICK_MS / 2); expect(api.state()!.tick).toBe(1);
  });
  it('renders one authoritative battlefield until the loss banner finishes, then enters score directly', () => {
    const { api, controller, render } = fixture(); api.start(); api.step(INTRO_TICKS);
    api.debug({ baseAlive: false });
    const borrowed = render.state;
    controller.frame(TICK_MS); expect(api.state()!.lossBannerTicks).toBe(256);
    controller.frame(TICK_MS); expect(render.state).toBe(borrowed);
    expect(api.state()!.lossBannerTicks).toBe(255);
    for (let i = 0; i < 255; i++) controller.frame(TICK_MS);
    expect(api.presentation().kind).toBe('score'); expect(api.state()!.phase).toBe('lost');
    const final = api.state(); controller.frame(100); expect(api.state()).toEqual(final);
  });
  it('clamps stage selection and repeats held A every eight ticks without directions or simultaneous A/B', () => {
    const { controller, api, pad } = fixture(); controller.startKey();
    pad.bPressed = true; controller.frame(TICK_MS); expect(api.presentation()).toMatchObject({ stage: 1 });
    pad.bPressed = false; pad.a = true;
    for (let i = 0; i < 9; i++) controller.frame(TICK_MS);
    expect(api.presentation()).toMatchObject({ stage: 3 });
    for (let i = 0; i < 300; i++) controller.frame(TICK_MS);
    expect(api.presentation()).toMatchObject({ stage: 35 });
    pad.b = true;
    for (let i = 0; i < 20; i++) controller.frame(TICK_MS);
    expect(api.presentation()).toMatchObject({ stage: 35 });
    pad.a = false; pad.b = false; pad.left = true;
    controller.frame(TICK_MS); expect(api.presentation()).toMatchObject({ stage: 35 });
    controller.inactive(); pad.left = false; pad.b = true; controller.startKey(); controller.frame(TICK_MS);
    expect(api.presentation()).toMatchObject({ stage: 34 });
  });
  it.each(['start','select'] as const)('lets %s skip brick GAME OVER after resume while preserving HISCORE', button => {
    const { controller, api } = fixture(); api.start();
    const players = api.state()!.players; players[0].score = 34500;
    api.debug({ phase: 'lost', players }); api.step(0);
    for (let i=0;i<1000 && api.presentation().kind!=='gameover';i++) controller.frame(TICK_MS);
    expect(api.presentation().kind).toBe('gameover');
    controller.inactive(); controller.selectKey(); expect(api.presentation().kind).toBe('gameover');
    controller.startKey(); expect(api.presentation().kind).toBe('gameover');
    if (button==='start') controller.startKey(); else controller.selectKey();
    expect(api.presentation()).toMatchObject({kind:'hiscore',highScore:34500});
    controller.startKey(); controller.selectKey(); expect(api.presentation().kind).toBe('hiscore');
  });
  it('isolates test snapshots while rendering the live state without a per-frame clone', () => {
    const { api, controller, render } = fixture(); api.start();
    const borrowed = render.state, copied = api.state()!;
    copied.players[0].lives = 99; copied.tiles.fill(0);
    controller.frame(TICK_MS); expect(render.state).toBe(borrowed);
    expect(api.state()!.players[0].lives).not.toBe(99);
  });
  it('does not accept input or advance audio after idempotent disposal', () => {
    const { controller, api, trace, input } = fixture(); api.start();
    const state = api.state(); controller.dispose(); controller.dispose(); trace.length = 0;
    controller.frame(100); controller.startKey(); controller.selectKey(); controller.inactive();
    expect(api.state()).toEqual(state); expect(trace).toEqual([]);
    expect(input.resetForFocus).toHaveBeenCalledOnce();
  });
});

describe('original result bonus ownership',()=>{
  it.each(['won','lost'] as const)('awards once at TOTAL plus fifteen ticks for %s, respecting elimination and ties',outcome=>{
    for(const eliminated of [false,true])for(const tie of [false,true]){
      const {controller,api,audio}=fixture();api.start('coop');
      const players=api.state()!.players;players[0].kills=[12,0,0,0];players[1].kills=[tie?12:8,0,0,0];
      players[0].score=19900;players[0].eliminated=eliminated;
      api.debug({phase:outcome,players});api.step(0);
      for(let i=0;i<200 && api.presentation().kind!=='score';i++)controller.frame(TICK_MS);
      expect(api.presentation().kind).toBe('score');
      const boundary=Math.round(scoreTimeline(api.state()!,0).bonusAtMs/TICK_MS);
      for(let i=0;i<boundary-1;i++)controller.frame(TICK_MS);
      expect(api.state()!.players[0].score).toBe(19900);
      controller.inactive();controller.frame(10000);expect(api.state()!.players[0].score).toBe(19900);
      controller.startKey();controller.frame(TICK_MS);
      const eligible=outcome==='won' && !eliminated && !tie;
      expect(api.state()!.players[0].score).toBe(eligible?20900:19900);
      expect(api.state()!.players[0].eliminated).toBe(eliminated);
      expect(api.presentation()).toMatchObject({bonusPlayer:eligible?0:null});
      for(let i=0;i<20;i++)controller.frame(TICK_MS);
      expect(api.state()!.players[0].score).toBe(eligible?20900:19900);
      const events=vi.mocked(audio.play).mock.calls.flatMap(([events])=>events);
      expect(events.filter(event=>event.type==='score-bonus')).toHaveLength(eligible?1:0);
      expect(events.filter(event=>event.type==='extra-life')).toHaveLength(eligible?1:0);
    }
  });
  it('gives player two the same surviving-leader award',()=>{
    const {controller,api}=fixture();api.start('coop');const players=api.state()!.players;
    players[0].kills=[1,0,0,0];players[1].kills=[2,0,0,0];api.debug({phase:'won',players});api.step(0);
    const boundary=Math.round(scoreTimeline(api.state()!,0).bonusAtMs/TICK_MS);
    for(let i=0;i<boundary;i++)controller.frame(TICK_MS);
    expect(api.presentation()).toMatchObject({bonusPlayer:1});expect(api.state()!.players.map(p=>p.score)).toEqual([0,1000]);
  });
});
