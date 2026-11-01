import { GameEngine } from '../core/engine';
import { ConstructionState } from '../core/construction';
import { BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE, TICK_MS, normalizeStage } from '../core/constants';
import { INTRO_TICKS } from '../core/rules';
import type { Direction, GameMode, PlayerCarry } from '../core/types';
import { getLevel } from '../data/levels';
import type { AppPorts } from './ports';
import { type AppState, isTimedState } from './state';
import { createAppTestAdapter, type AppTestAdapter } from './test-adapter';
import { scoreCompletionMs, scoreTimeline } from '../game/score-timeline';
import { AUDIO_SCENE_TICKS } from '../platform/audio-cues';

const GAMEOVER_TIME = AUDIO_SCENE_TICKS.gameover * TICK_MS;
const HISCORE_TIME = AUDIO_SCENE_TICKS.hiscore * TICK_MS;
/** Pure application flow; browser resources are owned by bootstrap. */
export class AppController {
  private state: AppState = { kind: 'menu' };
  private disposed = false;
  readonly testing?: AppTestAdapter;
  private get scene() { return this.ports.render; }
  private get audio() { return this.ports.audio; }
  private get input() { return this.ports.input; }
  private get highScore() { return this.ports.records.getHighScore(); }
  private get screen() { return this.state.kind; }
  private get engine() { return 'engine' in this.state ? this.state.engine : null; }
  private get presentationTicks() { return isTimedState(this.state) ? this.state.ticks : 0; }
  private get presentationTime() {
    return isTimedState(this.state) ? Math.max(0, this.state.duration - this.state.ticks * TICK_MS) : 0;
  }
  private construction = new ConstructionState();
  private customMapReady = false;
  private accumulator = 0;
  private selectedStage = 1;
  private selectedMode: GameMode = 'single';
  private menuSelection: 0 | 1 | 2 = 0;
  private stageHeld = 0;
  private stageHoldTicks = 0;
  private editorHeld = 0;
  private editorHoldTicks = 0;
  private presentationSuspended = false;
  private runHighScore: number;
  private lastScores = [0];
  constructor(private readonly ports: AppPorts) {
    this.runHighScore = this.highScore;
    this.menu();
    if (import.meta.env.MODE === 'test') this.testing = createAppTestAdapter({
      engine: () => this.engine, inGame: () => this.screen === 'game',
      construction: this.construction, render: this.scene,
      start: (mode, stage) => this.start(mode, stage), openEditor: () => this.openEditor(),
      updateDraft: () => {
        this.customMapReady = true; this.scene.draft = this.construction.tiles;
      },
      playEditor: mode => this.start(mode, this.selectedStage, undefined, true),
      finish: () => this.finishBattle(), present: () => this.present(),
    });
  }
  inactive(): void {
    if (this.disposed) return;
    this.input.resetForFocus(); this.accumulator = 0;
    this.stageHeld = 0; this.stageHoldTicks = 0;
    this.editorHeld = 0; this.editorHoldTicks = 0;
    if (!this.pause('focus')) { this.presentationSuspended = true; this.audio.setPaused(true, 'focus'); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.accumulator = 0; this.input.resetForFocus();
  }

  start(mode: GameMode, stage: number, carries?: PlayerCarry[], custom = this.customMapReady): void {
    if (this.disposed) return;
    if (!carries) this.runHighScore = this.highScore;

    this.input.clear(); this.audio.stopScene();
    const normalizedStage = normalizeStage(stage);
    const level = getLevel(normalizedStage);
    if (custom) {
      level.tiles = this.construction.tiles;
      // Starting a constructed stage restores the eagle without rebuilding
      // its surrounding walls. Player/enemy spawning clears its own terrain.
      const cell = BASE_Y / TILE_SIZE * GRID_SIZE + BASE_X / TILE_SIZE;
      for (const index of [cell, cell + 1, cell + GRID_SIZE, cell + GRID_SIZE + 1]) level.tiles[index] = 0;
    }
    const engine = new GameEngine(level, {
      mode, stage: normalizedStage, seed: this.ports.seed(), customMap: custom,
      ...(carries ? { players: carries } : {}),
    });
    this.state = { kind: 'game', engine }; this.accumulator = 0;
    this.presentationSuspended = false;
    this.scene.draft = null; this.scene.state = engine.state;

    this.audio.syncState(engine.state); this.audio.commitFrame();
    this.present();
  }

  private menu(): void {

    this.state = { kind: 'menu' }; this.scene.state = null; this.scene.draft = null;
    this.input.clear(); this.audio.stopScene();
    this.accumulator = 0; this.presentationSuspended = false;
    this.menuSelection = 0; this.selectedStage = 1;
    this.present();
  }

  private openEditor(): void {

    this.construction.enter();
    this.state = { kind: 'editor' }; this.scene.state = null; this.scene.draft = this.construction.tiles;
    this.customMapReady = true;
    this.input.clear(); this.audio.stopScene();
    this.accumulator = 0; this.presentationSuspended = false;
    this.stageHeld = 0; this.stageHoldTicks = 0;
    this.editorHeld = 0; this.editorHoldTicks = 0;
    this.present();
  }

  startKey(): void {
    if (this.disposed) return;
    if (this.screen === 'game') { if (this.engine?.state.phase === 'paused') this.resume(); else this.pause(); return; }
    if (this.presentationSuspended) {
      this.presentationSuspended = false; this.audio.setPaused(false); this.accumulator = 0;
      this.stageHeld = 0; this.stageHoldTicks = 0;
    this.editorHeld = 0; this.editorHoldTicks = 0;
      this.input.clear(); this.present(); return;
    }
    if (this.screen === 'gameover') { this.advancePresentation(); return; }
    if (this.screen === 'menu') {
      if (this.menuSelection === 2) this.openEditor();
      else {
        this.selectedMode = this.menuSelection === 1 ? 'coop' : 'single';
        this.state = { kind: 'stage-select' }; this.stageHeld = 0; this.stageHoldTicks = 0; this.input.clear(); this.accumulator = 0; this.present();
      }
    } else if (this.screen === 'stage-select') this.start(this.selectedMode, this.selectedStage);
    else if (this.screen === 'editor') this.menu();
  }

  selectKey(): void {
    if (this.disposed) return;
    if (this.screen === 'gameover' && !this.presentationSuspended) { this.advancePresentation(); return; }
    if (this.screen !== 'menu') return;
    this.presentationSuspended = false; this.audio.setPaused(false);
    this.menuSelection = ((this.menuSelection + 1) % 3) as 0 | 1 | 2;
    this.present();
  }

  private pause(reason: 'manual' | 'focus' = 'manual'): boolean {
    if (this.screen !== 'game' || !this.engine || !['intro', 'playing'].includes(this.engine.state.phase)) return false;
    this.engine.setPaused(true); this.input.clear(); this.accumulator = 0;
    this.audio.setPaused(true, reason); this.present();
    return true;
  }

  private resume(): void {
    if (this.screen !== 'game' || this.engine?.state.phase !== 'paused') return;
    this.engine.setPaused(false); this.input.clear(); this.accumulator = 0;
    this.presentationSuspended = false; this.audio.setPaused(false); this.present();
  }

  frame(delta: number, active = true): void {
    if (this.disposed || !active || this.presentationSuspended || this.engine?.state.phase === 'paused') {
      this.accumulator = 0; return;
    }
    this.accumulator += Math.min(Math.max(0, delta), 100);
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps++ < 6) {
      this.accumulator -= TICK_MS;
      if (this.screen === 'game' && this.engine) {
        this.audio.play(this.engine.step(this.input.read()));
        this.audio.syncState(this.engine.state);
        if (this.engine.state.phase === 'won' || this.engine.state.phase === 'lost') {
          this.audio.commitFrame();
          this.finishBattle(); return;
        }
      } else if (this.screen === 'editor') this.editorTick();
      else if (this.screen === 'stage-select') {
        this.stageTick();
      } else if (isTimedState(this.state)) {
        this.input.readPads();
        this.state.ticks++;
        if (this.state.kind === 'score') {
          const score = this.state;
          if (!score.bonusChecked && score.ticks * TICK_MS + 1e-7 >= scoreTimeline(score.engine.state, 0).bonusAtMs) {
            score.bonusChecked = true;
            const events = score.engine.awardCoopBonus();
            score.bonusPlayer = events.find(event => event.type === 'score-bonus')?.playerIndex ?? null;
            this.audio.play(events);
          }
          this.audio.updateScore(score.engine.state, score.ticks * TICK_MS);
        }
        if (!this.presentationTime) {
          // The boundary tick belongs to the scene it enters. Submit its new
          // cue before that page's first paint, without adding another tick.
          this.advancePresentation(); this.audio.commitFrame(); return;
        }
      } else this.input.readPads();
    }
    this.audio.commitFrame();
    this.present();
  }

  private stageTick(): void {
    const pad = this.input.readPads()[0];
    const a = pad.a || pad.aPressed, b = pad.b || pad.bPressed;
    const direction = a === b ? 0 : a ? 1 : -1;
    if (!direction) { this.stageHeld = 0; this.stageHoldTicks = 0; return; }
    let change = false;
    if (direction !== this.stageHeld || (direction > 0 ? pad.aPressed : pad.bPressed)) {
      this.stageHeld = direction; this.stageHoldTicks = 0; change = true;
    } else if (++this.stageHoldTicks === 8) { this.stageHoldTicks = 0; change = true; }
    if (change) this.selectedStage = Math.max(1, Math.min(35, this.selectedStage + direction));
  }

  private editorTick(): void {
    const pad = this.input.readPads()[0];
    let changed = false;
    const held = Number(pad.right) | Number(pad.left) << 1 | Number(pad.down) << 2 | Number(pad.up) << 3;
    let movement = held & ~this.editorHeld;
    this.editorHeld = held;
    if (held) { this.construction.directionHeld(); this.editorHoldTicks++; }
    else {
      this.editorHoldTicks = 0;
      if (pad.aPressed || pad.bPressed) changed = this.construction.press(pad.aPressed ? 1 : -1);
    }
    // Retain the held-Dpad timer across direction changes. Tick 20 repeats;
    // resetting to 15 then produces five-tick repeats.
    if (this.editorHoldTicks === 20) { this.editorHoldTicks = 15; movement = held; }
    const direction: Direction | null = movement & 1 ? 'right' : movement & 2 ? 'left' : movement & 4 ? 'down' : movement & 8 ? 'up' : null;
    if (direction) this.construction.move(direction);
    if (held && (pad.a || pad.b)) changed = this.construction.paint() || changed;
    if (changed) this.scene.draft = this.construction.tiles;
  }

  private finishBattle(): void {
    this.lastScores = this.engine!.state.players.map(player => player.score);
    this.showScore();
  }

  private showScore(): void {

    const engine = this.engine!;
    this.state = { kind: 'score', engine, duration: scoreCompletionMs(engine.state), ticks: 0, bonusChecked: false, bonusPlayer: null };
    this.input.clear(); this.accumulator = 0;
    this.audio.stopScene(); this.audio.updateScore(this.engine!.state, 0);
    this.present();
  }

  private advancePresentation(): void {
    if (this.screen === 'score' && this.engine) {
      const state = this.engine.state;
      if (state.phase === 'won') {
        const players = state.players.map(({ score, lives, stars, nextExtraLife, eliminated }) =>
          ({ score, lives, stars, nextExtraLife, eliminated }));
        this.start(state.mode, state.stage === 70 ? 1 : state.stage + 1, players, false);
      } else {
        this.state = { kind: 'gameover', engine: this.engine, duration: GAMEOVER_TIME, ticks: 0 };
        this.construction.reset(); this.customMapReady = false;
        this.input.clear(); this.audio.stopScene(); this.audio.startPresentation('gameover'); this.present();
      }
      return;
    }
    if (this.screen === 'gameover') {
      // The original updates the powered-on record after the brick page,
      // rather than displaying this run's new record during its tally.
      this.recordHighScore();
      if (Math.max(...this.lastScores) > this.runHighScore) {
        this.state = { kind: 'hiscore', engine: this.engine!, duration: HISCORE_TIME, ticks: 0 };
        this.input.clear(); this.audio.stopScene(); this.audio.startPresentation('hiscore'); this.present(); return;
      }
    }
    this.menu();
  }

  private recordHighScore(): void {
    const score = Math.max(0, ...(this.engine?.state.players.map(player => player.score) ?? []));
    this.ports.records.highScore(score);
  }

  private present(): void {
    const state = this.engine?.state;
    if (this.screen === 'menu') this.scene.presentation = {
      kind: 'menu', selection: this.menuSelection, highScore: this.highScore, playerScores: this.lastScores,
    };
    else if (this.screen === 'stage-select') this.scene.presentation = { kind: 'stage-select', stage: this.selectedStage, mode: this.selectedMode };
    else if (this.screen === 'editor') {
      const cursor = this.construction.cursor;
      this.scene.presentation = { kind: 'editor', cursor: { x: cursor.x * 2, y: cursor.y * 2 }, baseVisible: this.construction.baseVisible };
    } else if (this.screen === 'score' && state) this.scene.presentation = {
      kind: 'score', state, highScore: this.highScore, elapsedMs: this.presentationTicks * TICK_MS,
      bonusPlayer: this.state.kind === 'score' ? this.state.bonusPlayer : null,
    };
    else if (this.screen === 'gameover') this.scene.presentation = { kind: 'gameover', highScore: this.highScore };
    else if (this.screen === 'hiscore') this.scene.presentation = { kind: 'hiscore', highScore: this.highScore, tick: this.presentationTicks };
    else if (state && state.introTicks > 0) this.scene.presentation = {
      kind: 'intro', stage: state.stage, elapsedMs: (INTRO_TICKS - state.introTicks) * TICK_MS,
      paused: state.phase === 'paused',
    };
    else this.scene.presentation = { kind: 'game', paused: state?.phase === 'paused' };
  }
}

