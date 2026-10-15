import type { GameEvent, GameState } from '../core/types';
import { scoreTimeline } from '../game/score-timeline';
import { CUE } from './audio-cues';
import { AudioRuntime } from './audio-runtime';
import { AudioTransport } from './audio-transport';

type Music = 'intro' | 'gameover' | 'hiscore' | null;
const MUSIC_TRACKS = {
  intro: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2],
  gameover: [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle],
  hiscore: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle],
} as const;

/** Maps game semantics to cues and retains the current persistent scene. */
export class GameAudio {
  private readonly transport: AudioTransport;
  private music: Music = null;
  private musicTicks = 0;
  private introPlayed = false;
  private engine: 'player' | 'enemy' | null = null;
  private ice = false;
  private lastMovingTick = -100;
  private scoreState?: GameState;
  private scoreCues = 0;
  private scoreBonus = false;
  constructor(volume: number, clock?: () => number) {
    this.transport = new AudioTransport(volume, () => ({
      start: [ ...(this.music ? MUSIC_TRACKS[this.music] : []),
        ...(this.engine ? [this.engine === 'player' ? CUE.playerEngine : CUE.enemyEngine] : []) ],
      offset: this.musicTicks,
    }), hooks => new AudioRuntime(hooks, clock));
  }
  unlock(): void { this.transport.unlock(); }
  dispose(): Promise<void> { return this.transport.dispose(); }
  setPaused(paused: boolean, reason: 'manual' | 'focus' = 'manual'): void { this.transport.setPaused(paused, reason); }
  stopScene(): void {
    this.music = null; this.musicTicks = 0; this.introPlayed = false; this.engine = null; this.ice = false;
    this.scoreState = undefined; this.scoreCues = 0; this.scoreBonus = false; this.lastMovingTick = -100;
    this.transport.stopScene();
  }
  startPresentation(music: Exclude<Music, 'intro' | null>): void { this.startMusic(music); }
  private startMusic(music: Exclude<Music, null>): void {
    this.music = music; this.musicTicks = 0;
    for (const id of MUSIC_TRACKS[music]) this.cue(id);
  }
  syncState(state: GameState | null): void {
    if (state?.phase === 'intro' && !this.introPlayed) { this.startMusic('intro'); this.introPlayed = true; }
    const active = state?.phase === 'playing' && state.pendingOutcome === null;
    const players = active ? state.tanks.filter(tank => tank.team === 'player' && !tank.spawnTicks) : [];
    if (state && players.some(tank => tank.moving && !tank.stunTicks)) this.lastMovingTick = state.tick;
    const engine = active ? (state.tick - this.lastMovingTick <= 1 ? 'player' : 'enemy') : null;
    if (engine !== this.engine) {
      this.stop(CUE.playerEngine); this.stop(CUE.enemyEngine);
      if (engine) this.cue(engine === 'player' ? CUE.playerEngine : CUE.enemyEngine);
      this.engine = engine;
    }
    const ice = players.some(tank => tank.slideTicks > 0);
    if (ice && !this.ice) this.cue(CUE.ice);
    this.ice = ice;
  }
  updateScore(state: GameState, elapsedMs: number): void {
    const timeline = scoreTimeline(state, elapsedMs);
    if (this.scoreState !== state) { this.scoreState = state; this.scoreCues = 0; this.scoreBonus = false; }
    if (timeline.cueCount > this.scoreCues) { this.cue(CUE.countPulse); this.cue(CUE.countNoise); }
    const bonus = state.phase === 'won' && timeline.totalVisible && state.mode === 'coop' && timeline.totals.length === 2 && timeline.totals[0] !== timeline.totals[1];
    if (bonus && !this.scoreBonus) this.cue(CUE.bonus1000);
    this.scoreCues = timeline.cueCount; this.scoreBonus = bonus;
  }
  play(events: readonly GameEvent[]): void {
    for (const event of events) switch (event.type) {
      case 'fire': if (event.team === 'player') this.cue(CUE.shot); break;
      case 'hit': {
        if (event.target === 'tank') { if (event.tankTeam !== 'player') this.cue(CUE.tank); }
        else if (event.steelPower && event.target !== 'boundary') this.cue(CUE.brick);
        else if ((event.gunSlot ?? (event.team === 'player' ? 0 : 2)) < 2) this.cue(event.target === 'brick' ? CUE.brick : CUE.wall);
        break;
      }
      case 'explosion':
        if (event.owner === 'base') { this.cue(CUE.baseExplosion); this.cue(CUE.playerExplosion); }
        else this.cue(event.owner === 'enemy' ? CUE.enemyExplosion : CUE.playerExplosion);
        break;
      case 'powerup': this.cue(event.action === 'appear' ? CUE.appear : CUE.pickup); break;
      case 'extra-life': this.cue(CUE.lifePulse1); this.cue(CUE.lifePulse2); break;
      case 'stage-start': if (!this.introPlayed) { this.startMusic('intro'); this.introPlayed = true; } break;
      case 'stage-clear': case 'game-over': break;
    }
  }
  private cue(id: number): void { this.transport.cue(id); }
  private stop(id: number): void { this.transport.stop(id); }
  advanceTick(): void { if (this.music) this.musicTicks++; this.transport.advanceTick(); }
  commitFrame(): void { this.transport.commitFrame(); }
}
