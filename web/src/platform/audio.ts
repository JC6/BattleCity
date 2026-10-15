import type { GameEvent, GameState } from '../core/types';
import { scoreTimeline } from '../game/score-timeline';
import { CUE, AUDIO_TICK_HZ, isPersistentCue } from './audio-cues';
import type { AudioFrame, AudioMessage } from './apu-worklet';
import workletURL from './apu-worklet.ts?worker&url';

type Music = 'intro' | 'gameover' | 'hiscore' | null;
interface PendingFrame extends AudioFrame { queuedAt: number }
const MUSIC_TRACKS = {
  intro: [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2],
  gameover: [CUE.gameoverPulse1, CUE.gameoverPulse2, CUE.gameoverTriangle],
  hiscore: [CUE.hiscorePulse1, CUE.hiscorePulse2, CUE.hiscoreTriangle],
} as const;

/** Game ticks own cue progress, the Worklet owns sample time. Batches and scene
 * generations are bounded; locked or paused cues never accumulate. */
export class GameAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private gainParameter?: AudioParam;
  private gainValue?: number;
  private node?: AudioWorkletNode;
  private generationReady = false;
  private sceneActive = false;
  private loading?: Promise<void>;
  private resumeSyncNeeded = false;
  private generation = 0;
  private sequence = 0;
  private rejectionFloor = 0;
  private tick = 0;
  private paused = false;
  private pauseReason: 'manual' | 'focus' = 'manual';
  private music: Music = null;
  private musicTicks = 0;
  private introPlayed = false;
  private engine: 'player' | 'enemy' | null = null;
  private ice = false;
  private lastMovingTick = -100;
  private scoreState?: GameState;
  private scoreCues = 0;
  private scoreBonus = false;
  private starts = new Set<number>();
  private stops = new Set<number>();
  private pending: PendingFrame[] = [];
  private inFlight = false;
  private credits = 12;
  private flushQueued = false;
  private nextTime = 0;
  constructor(private readonly volume: number) {}

  unlock(): void {
    try {
      if (!this.context) {
        this.context = new AudioContext(); this.gain = this.context.createGain();
        this.gainParameter = this.gain.gain;
        this.gainParameter.value = 0; this.gainValue = 0;
        this.gain.connect(this.context.destination);
      }
      const context = this.context;
      const running = context.state === 'running';
      if (!running) { this.resumeSyncNeeded = true; this.applyGain(); }
      // Keep native resume and deferred recovery in gestures that need them.
      // A running context with no recovery barrier already owns its scene.
      if (!running || this.resumeSyncNeeded) void context.resume().then(() => this.synchronizeResume()).catch(() => {});
      if (!this.loading) {
        this.loading = context.audioWorklet.addModule(workletURL).then(() => {
          this.node = new AudioWorkletNode(context, 'battlecity-apu', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          this.node.connect(this.gain!);
          this.node.port.onmessage = event => {
            const message = event.data;
            if (message.generation !== this.generation) return;
            if (message.type === 'ack' && message.accepted === false) {
              // Any rejected outstanding batch lost authoritative ticks, even
              // when a later batch was already sent. Control barriers exclude
              // acknowledgements from the queue discarded by pause/reset.
              if (Number.isInteger(message.sequence) && message.sequence > this.rejectionFloor && message.sequence <= this.sequence) this.resynchronize();
              return;
            }
            const accepted = message.type === 'ack' && message.accepted === true && Number.isInteger(message.sequence)
              && message.sequence > this.rejectionFloor && message.sequence <= this.sequence && this.validCredits(message.credits);
            // FIFO reception of any current batch proves the scene reset ran.
            // Newer posts still reserve capacity until their own ACK arrives.
            if (accepted && !this.generationReady) { this.generationReady = true; this.applyGain(); }
            if (message.sequence !== this.sequence) return;
            if (message.type === 'ack') {
              if (!this.inFlight || !accepted) return;
              this.inFlight = false; this.credits = message.credits;
              if (Number.isFinite(message.nextAt)) this.nextTime = Math.max(this.nextTime, message.nextAt);
            } else if (message.type === 'progress') {
              // An older consumption snapshot cannot restore capacity reserved
              // for a batch whose reception is still unacknowledged.
              if (this.inFlight || !this.validCredits(message.credits) || !Number.isFinite(message.nextAt)) return;
              this.credits = message.credits; this.nextTime = Math.max(this.nextTime, message.nextAt);
            } else return;
            this.flush();
          };
          // Loading after resume already initializes the current persistent
          // snapshot. Loading before resume leaves the recovery pending.
          this.resumeSyncNeeded = context.state !== 'running';
          this.resetProcessor(); this.applyPause();
        }).catch(() => { /* Unsupported audio stays silent; keyboard play remains available. */ });
      }
    } catch { /* Audio construction failure must not prevent gameplay. */ }
  }

  private synchronizeResume(): void {
    if (!this.resumeSyncNeeded || !this.node || this.context?.state !== 'running') return;
    // Concurrent resume promises consume this barrier only once. Read the
    // current scene and offset, including changes made while audio was locked.
    this.resumeSyncNeeded = false; this.starts.clear(); this.stops.clear();
    this.resynchronize();
  }

  setPaused(paused: boolean, reason: 'manual' | 'focus' = 'manual'): void {
    if (this.paused === paused && (!paused || this.pauseReason === reason)) return;
    this.paused = paused; this.pauseReason = reason;
    this.sequence++; this.rejectionFloor = this.sequence;
    const discarded = this.pending;
    this.pending = []; this.inFlight = false; this.credits = 12; this.nextTime = 0;
    this.applyPause(discarded);
    this.starts.clear(); this.stops.clear();
  }
  private applyPause(frames: PendingFrame[] = []): void {
    this.applyGain();
    this.post({ type: 'pause', generation: this.generation, paused: this.paused, reason: this.pauseReason,
      tick: this.tick, frames: frames.map(({ tick, start, stop }) => ({ tick, start, stop })),
      start: [...this.starts], stop: [...this.stops] });
    // Prove FIFO reset/unpause reception without advancing an actual driver
    // step. The gain must open before a real attack can reach the processor.
    if (this.node && !this.paused && !this.resumeSyncNeeded && !this.generationReady && !this.inFlight) {
      this.sequence++; this.inFlight = true;
      this.post({ type: 'frames', generation: this.generation, sequence: this.sequence, at: this.nextTime, frames: [] });
    }
  }
  private applyGain(): void {
    if (!this.gain) return;
    const target = this.paused
      ? (this.pauseReason === 'manual' ? this.volume : 0)
      : (!this.resumeSyncNeeded && this.generationReady && this.sceneActive ? this.volume : 0);
    if (target === this.gainValue) return;
    const parameter = this.gainParameter ??= this.gain.gain;
    parameter.value = target;
    this.gainValue = target;
  }
  stopScene(): void {
    this.generation++; this.pending = []; this.starts.clear(); this.stops.clear(); this.inFlight = false; this.credits = 12;
    this.rejectionFloor = this.sequence;
    this.music = null; this.musicTicks = 0; this.introPlayed = false; this.engine = null; this.ice = false;
    this.scoreState = undefined; this.scoreCues = 0; this.scoreBonus = false; this.lastMovingTick = -100;
    this.nextTime = 0; this.sceneActive = false; this.paused = false;
    this.resetProcessor(); this.applyPause();
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
  private cue(id: number): void {
    if (this.ready()) { this.starts.add(id); this.sceneActive = true; this.applyGain(); }
  }
  private stop(id: number): void { if (this.ready()) this.stops.add(id); }
  private ready(): boolean { return !!this.node && this.context?.state === 'running' && !this.resumeSyncNeeded && !this.paused && this.volume > 0; }
  /** Once at the end of each actual simulation tick, after cues/state sync. */
  advanceTick(): void {
    this.tick++; if (this.music) this.musicTicks++;
    if (!this.ready()) { this.starts.clear(); this.stops.clear(); return; }
    // A reset scene has no driver work until a real cue starts. The zero-frame
    // control proof does not need a simulated step or reserve FIFO capacity.
    const silentLead = !this.sceneActive && !this.music && !this.engine && !this.starts.size && !this.stops.size;
    if (silentLead) return;
    this.pending.push({ tick: this.tick, start: [...this.starts], stop: [...this.stops], queuedAt: this.context!.currentTime });
    this.starts.clear(); this.stops.clear();
    if (this.pending.length > 12) {
      // A stalled render/audio port gets a fresh generation at the current
      // music offset. This advances persistent state silently and discards
      // expired attacks instead of stretching the song or replaying a burst.
      const now = this.pending[this.pending.length - 1].queuedAt;
      const recovery = this.pending
        .filter(frame => now - frame.queuedAt >= 0 && now - frame.queuedAt <= 2 / AUDIO_TICK_HZ)
        .map(frame => ({ at: frame.queuedAt, start: frame.start.filter(id => !isPersistentCue(id)) }))
        .filter(frame => frame.start.length > 0).slice(-12);
      this.resynchronize(recovery);
    }
    if (!this.flushQueued) {
      this.flushQueued = true; queueMicrotask(() => { this.flushQueued = false; this.flush(); });
    }
  }
  /** Submit actual fixed steps before the frame paints its canvas. */
  commitFrame(): void { this.flush(); }
  private flush(): void {
    if (!this.generationReady || !this.credits || !this.pending.length || !this.ready()) return;
    // A failed native gain setter must not let the already proved generation
    // submit its first attack while still muted. A cached success avoids another setter.
    this.applyGain();
    const now = this.context!.currentTime;
    // Preserve completed ticks and persistent state, without replaying attacks
    // that expired while processor capacity was unavailable. A recovery keeps
    // its original creation clock separate from playback deadlines and game ticks.
    const count = Math.min(this.pending.length, this.credits);
    const frames = this.pending.splice(0, count).map(({ tick, start, stop, queuedAt }) => ({ tick, stop,
      start: now - queuedAt > 2 / AUDIO_TICK_HZ ? start.filter(isPersistentCue) : start }));
    this.nextTime = Math.max(this.nextTime, now);
    // Reserve unacknowledged posts too. FIFO reception makes only the latest
    // ACK's credit snapshot safe to restore across these bounded batches.
    this.credits -= count; this.inFlight = true; this.sequence++;
    this.post({ type: 'frames', generation: this.generation, sequence: this.sequence, at: this.nextTime, frames });
    this.nextTime += frames.length / AUDIO_TICK_HZ;
  }
  private validCredits(credits: unknown): credits is number {
    return typeof credits === 'number' && Number.isInteger(credits) && credits >= 0 && credits <= 12;
  }
  private resynchronize(recovery: { at: number; start: number[] }[] = []): void {
    // Persistent state seeks the authoritative offset. Only local overflow may
    // retain unposted, still-fresh attacks on their original native clocks.
    this.generation++; this.pending = []; this.inFlight = false; this.credits = 12; this.nextTime = 0;
    this.rejectionFloor = this.sequence;
    this.resetProcessor(recovery); this.applyPause();
  }
  private resetProcessor(recovery: { at: number; start: number[] }[] = []): void {
    const start: number[] = this.music ? [...MUSIC_TRACKS[this.music]] : [];
    if (this.engine) start.push(this.engine === 'player' ? CUE.playerEngine : CUE.enemyEngine);
    // Native gain blocks the old scene while its asynchronous reset is pending.
    // An empty scene stays silent after ACK; recovered persistent state and a
    // new real cue can activate only after FIFO reception proves this reset ran.
    this.generationReady = false; this.sceneActive ||= start.length > 0; this.applyGain();
    this.post({ type: 'reset', generation: this.generation, start, offset: this.musicTicks, tick: this.tick,
      ...(recovery.length ? { recovery } : {}) });
  }
  private post(message: AudioMessage): void { this.node?.port.postMessage(message); }
}
