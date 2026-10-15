import Phaser from 'phaser';
import './styles.css';
import { GameEngine } from './core/engine';
import { ConstructionState } from './core/construction';
import { LossPresentationWorld } from './core/loss-presentation';
import { BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE, TICK_MS, normalizeStage } from './core/constants';
import { INTRO_TICKS } from './core/rules';
import { EMPTY_INPUT, type Tile, type Direction, type GameMode, type GameState, type PlayerCarry, type PlayerInput } from './core/types';
import { getLevel } from './data/levels';
import { ArenaScene, CANVAS_HEIGHT, CANVAS_WIDTH } from './game/arena';
import { scoreCompletionMs } from './game/score-timeline';
import { GameAudio } from './platform/audio';
import { AUDIO_SCENE_TICKS } from './platform/audio-cues';
import { InputManager } from './platform/input';
import { storage } from './platform/storage';

type Screen = 'menu' | 'stage-select' | 'game' | 'loss' | 'score' | 'gameover' | 'hiscore' | 'editor';
const LOSS_TIME = 2000;
const GAMEOVER_TIME = AUDIO_SCENE_TICKS.gameover * TICK_MS;
const HISCORE_TIME = AUDIO_SCENE_TICKS.hiscore * TICK_MS;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<main class="site-shell"><div class="screen-wrap"><div id="game-canvas" role="img" ' +
  'aria-label="Battle City。Enter：Start，右 Shift：Select。1P：WASD、J/K。2P：方向键、N/M。"></div></div></main>';

class BattleCityApp {
  readonly scene = new ArenaScene();
  private engine: GameEngine | null = null;
  private lossWorld: LossPresentationWorld | null = null;
  private construction = new ConstructionState();
  private draft = this.construction.tiles;
  private customMapReady = false;
  private screen: Screen = 'menu';
  private accumulator = 0;
  private selectedStage = 1;
  private selectedMode: GameMode = 'single';
  private preparedStart: { mode: GameMode; stage: number; engine: GameEngine } | null = null;
  private menuSelection: 0 | 1 | 2 = 0;
  private editorHeld = 0;
  private editorHoldTicks = 0;
  private presentationTime = 0;
  private presentationDuration = 0;
  private presentationTicks = 0;
  private presentationSuspended = false;
  private highScore = storage.getHighScore();
  private runHighScore = this.highScore;
  private lastScores = [0];
  private audio = new GameAudio(0.3);
  private input = new InputManager(() => this.startKey(), () => this.selectKey(), () => this.audio.unlock());

  constructor() {
    this.scene.onFrame = delta => this.frame(delta);
    const resize = () => {
      const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / CANVAS_WIDTH, window.innerHeight / CANVAS_HEIGHT)));
      const wrapper = app.querySelector<HTMLElement>('.screen-wrap')!;
      wrapper.style.width = CANVAS_WIDTH * scale + 'px';
      wrapper.style.height = CANVAS_HEIGHT * scale + 'px';
      // FIT uses cached parent dimensions, so measure the resized wrapper first.
      this.scene.scale?.getParentBounds();
      this.scene.scale?.refresh();
    };
    resize();
    new Phaser.Game({
      type: Phaser.CANVAS, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
      parent: 'game-canvas', backgroundColor: '#000000', pixelArt: true,
      roundPixels: true, antialias: false, scene: [this.scene],
      audio: { noAudio: true }, input: { mouse: false, touch: false },
      // A throttled display RAF must not delay the fixed simulation or audio.
      // Phaser still supplies real elapsed time to the same bounded accumulator.
      fps: { smoothStep: false, forceSetTimeOut: true },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
    window.addEventListener('resize', resize);
    const inactive = () => {
      this.input.resetForFocus(); this.accumulator = 0;
      this.editorHeld = 0; this.editorHoldTicks = 0;
      if (!this.pause('focus')) { this.presentationSuspended = true; this.audio.setPaused(true, 'focus'); }
    };
    window.addEventListener('blur', inactive);
    document.addEventListener('visibilitychange', () => { if (document.hidden) inactive(); });
    this.menu();
    // Keep the whole harness in a compile-time branch so production contains
    // neither a callable debug method nor its entry-point names.
    if (import.meta.env.MODE === 'test') {
      Object.assign(window, { __BATTLECITY__: {
        state: (): GameState | null => this.engine ? structuredClone(this.engine.state) : null,
        presentation: () => structuredClone(this.scene.presentation),
        start: (mode: GameMode = 'single', stage = 1) => this.start(mode, stage),
        step: (count = 1, inputs: PlayerInput[] = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }]): void => {
          if (!this.engine) return;
          for (let i = 0; i < Math.min(10000, Math.max(0, count)); i++) {
            this.engine.step(inputs);
            this.scene.observeStep(this.engine.state);
          }
          if (this.screen === 'game' && ['won', 'lost'].includes(this.engine.state.phase)) this.finishBattle();
          else this.present();
        },
        debug: (patch: Partial<GameState>) => { if (this.engine) Object.assign(this.engine.state, patch); },
        openEditor: () => this.openEditor(),
        editor: () => ({ cursor: this.construction.cursor, selectedCode: this.construction.selectedCode }),
        setEditorTile: (index: number, tile: Tile): void => {
          if (!this.construction.setTile(index, tile)) return;
          this.draft = this.construction.tiles;
          this.customMapReady = true;
          this.scene.draft = this.draft;
        },
        getEditorTiles: () => [...this.draft],
        playEditor: (mode: GameMode = 'single') => this.start(mode, this.selectedStage, undefined, true),
        renderScene: () => this.scene,
      } });
    }
  }

  start(mode: GameMode, stage: number, carries?: PlayerCarry[], custom = this.customMapReady): void {
    const prepared = this.preparedStart;
    this.preparedStart = null;
    if (!carries) this.runHighScore = this.highScore;
    this.clearLossPresentation();
    this.input.clear(); this.audio.stopScene();
    const normalizedStage = normalizeStage(stage);
    if (this.screen === 'stage-select' && !custom && !this.customMapReady && carries === undefined &&
        prepared?.mode === mode && prepared.stage === normalizedStage &&
        prepared.engine.state.tick === 0 && prepared.engine.state.phase === 'intro') {
      this.engine = prepared.engine;
    } else {
      const level = getLevel(normalizedStage);
      if (custom) {
        level.tiles = [...this.draft];
        // Starting a constructed stage restores the eagle without rebuilding
        // its surrounding walls. Player/enemy spawning clears its own terrain.
        const cell = BASE_Y / TILE_SIZE * GRID_SIZE + BASE_X / TILE_SIZE;
        for (const index of [cell, cell + 1, cell + GRID_SIZE, cell + GRID_SIZE + 1]) level.tiles[index] = 0;
      }
      this.engine = new GameEngine(level, {
        mode, stage: normalizedStage, seed: crypto.getRandomValues(new Uint32Array(1))[0],
        ...(carries ? { players: carries } : {}),
      });
    }
    this.screen = 'game'; this.accumulator = 0; this.presentationTime = 0;
    this.presentationSuspended = false;
    this.scene.draft = null; this.scene.state = this.engine.state;
    this.scene.resetAnimation(); this.scene.observeStep(this.engine.state);
    this.audio.syncState(this.engine.state);
    this.present();
  }

  private prepareSelectedStart(): void {
    this.preparedStart = null;
    if (this.screen !== 'stage-select' || this.customMapReady) return;
    try {
      const mode = this.selectedMode, stage = normalizeStage(this.selectedStage);
      // Only pure tick-zero state is prepared. Its random seed is sampled here;
      // no scene, audio or simulation step observes it before a matching Start.
      const engine = new GameEngine(getLevel(stage), {
        mode, stage, seed: crypto.getRandomValues(new Uint32Array(1))[0],
      });
      this.preparedStart = { mode, stage, engine };
    } catch { /* A failed preparation leaves Start's original fresh path intact. */ }
  }

  private menu(): void {
    this.preparedStart = null;
    this.clearLossPresentation();
    this.screen = 'menu'; this.engine = null; this.scene.state = null; this.scene.draft = null;
    this.input.clear(); this.audio.stopScene();
    this.accumulator = 0; this.presentationTime = 0; this.presentationSuspended = false;
    this.menuSelection = 0; this.selectedStage = 1;
    this.scene.resetAnimation(); this.present();
  }

  private openEditor(): void {
    this.preparedStart = null;
    this.clearLossPresentation();
    this.construction.enter();
    this.screen = 'editor'; this.engine = null; this.scene.state = null; this.scene.draft = this.draft;
    this.customMapReady = true;
    this.input.clear(); this.audio.stopScene();
    this.accumulator = 0; this.presentationSuspended = false;
    this.editorHeld = 0; this.editorHoldTicks = 0;
    this.scene.resetAnimation(); this.present();
  }

  private startKey(): void {
    if (this.screen === 'game') { if (this.engine?.state.phase === 'paused') this.resume(); else this.pause(); return; }
    if (this.presentationSuspended) {
      this.presentationSuspended = false; this.audio.setPaused(false); this.accumulator = 0;
      this.editorHeld = 0; this.editorHoldTicks = 0;
      this.input.clear(); this.present(); return;
    }
    if (this.screen === 'menu') {
      if (this.menuSelection === 2) this.openEditor();
      else {
        this.selectedMode = this.menuSelection === 1 ? 'coop' : 'single';
        this.screen = 'stage-select'; this.input.clear(); this.accumulator = 0; this.present();
        this.prepareSelectedStart();
      }
    } else if (this.screen === 'stage-select') this.start(this.selectedMode, this.selectedStage);
    else if (this.screen === 'editor') this.menu();
  }

  private selectKey(): void {
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

  private frame(delta: number): void {
    if (document.hidden || !document.hasFocus() || this.presentationSuspended || this.engine?.state.phase === 'paused') {
      this.accumulator = 0; return;
    }
    this.accumulator += Math.min(Math.max(0, delta), 100);
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps++ < 6) {
      this.accumulator -= TICK_MS;
      if (this.screen === 'game' && this.engine) {
        this.audio.play(this.engine.step(this.input.read()));
        this.scene.observeStep(this.engine.state);
        this.audio.syncState(this.engine.state);
        if (this.engine.state.phase === 'won' || this.engine.state.phase === 'lost') {
          this.audio.advanceTick();
          this.audio.commitFrame();
          this.finishBattle(); return;
        }
      } else if (this.screen === 'editor') this.editorTick();
      else if (this.screen === 'stage-select') {
        const pad = this.input.readPads()[0];
        if (pad.aPressed !== pad.bPressed) {
          this.selectedStage = (this.selectedStage - 1 + (pad.aPressed ? 1 : 34)) % 35 + 1;
          this.prepareSelectedStart();
        }
      } else if (['loss', 'score', 'gameover', 'hiscore'].includes(this.screen)) {
        this.input.readPads();
        this.presentationTicks++;
        this.presentationTime = Math.max(0, this.presentationDuration - this.presentationTicks * TICK_MS);
        if (this.screen === 'loss' && this.lossWorld) {
          this.lossWorld.step(); this.scene.observeStep(this.lossWorld.state);
        } else if (this.screen === 'score' && this.engine) {
          this.audio.updateScore(this.engine.state, this.presentationTicks * TICK_MS);
        }
        if (!this.presentationTime) {
          // The boundary tick belongs to the scene it enters. Submit its new
          // cue before that page's first paint, without adding another tick.
          this.advancePresentation(); this.audio.advanceTick(); this.audio.commitFrame(); return;
        }
      } else this.input.readPads();
      this.audio.advanceTick();
    }
    this.audio.commitFrame();
    this.present();
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
    if (changed) { this.draft = this.construction.tiles; this.scene.draft = this.draft; }
  }

  private finishBattle(): void {
    this.lastScores = this.engine!.state.players.map(player => player.score);
    if (this.engine!.state.phase === 'won') { this.showScore(); return; }
    this.screen = 'loss'; this.input.clear(); this.accumulator = 0;
    this.lossWorld = new LossPresentationWorld(this.engine!.state);
    this.scene.state = this.lossWorld.state; this.scene.hudState = this.engine!.state;
    this.presentationDuration = this.presentationTime = LOSS_TIME;
    this.presentationTicks = 0;
    this.audio.syncState(null); this.present();
  }

  private showScore(): void {
    this.clearLossPresentation();
    this.screen = 'score'; this.input.clear(); this.accumulator = 0;
    this.presentationDuration = this.presentationTime = scoreCompletionMs(this.engine!.state);
    this.presentationTicks = 0;
    this.audio.stopScene(); this.audio.updateScore(this.engine!.state, 0);
    this.present();
  }

  private clearLossPresentation(): void {
    this.lossWorld = null; this.scene.hudState = null;
    this.scene.state = this.engine?.state ?? null;
  }

  private advancePresentation(): void {
    if (this.screen === 'loss') { this.showScore(); return; }
    if (this.screen === 'score' && this.engine) {
      const state = this.engine.state;
      if (state.phase === 'won') {
        const players = state.players.map(({ score, lives, stars, nextExtraLife, eliminated }) =>
          ({ score, lives, stars, nextExtraLife, eliminated }));
        this.start(state.mode, state.stage === 70 ? 1 : state.stage + 1, players, false);
      } else {
        this.screen = 'gameover'; this.presentationDuration = this.presentationTime = GAMEOVER_TIME;
        this.presentationTicks = 0;
        this.construction.reset(); this.draft = this.construction.tiles; this.customMapReady = false;
        this.input.clear(); this.audio.stopScene(); this.audio.startPresentation('gameover'); this.present();
      }
      return;
    }
    if (this.screen === 'gameover') {
      // The original updates the powered-on record after the brick page,
      // rather than displaying this run's new record during its tally.
      this.recordHighScore();
      if (Math.max(...this.lastScores) > this.runHighScore) {
        this.screen = 'hiscore'; this.presentationDuration = this.presentationTime = HISCORE_TIME;
        this.presentationTicks = 0;
        this.input.clear(); this.audio.stopScene(); this.audio.startPresentation('hiscore'); this.present(); return;
      }
    }
    this.menu();
  }

  private recordHighScore(): void {
    const score = Math.max(0, ...(this.engine?.state.players.map(player => player.score) ?? []));
    this.highScore = storage.highScore(score);
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
    };
    else if (this.screen === 'gameover') this.scene.presentation = { kind: 'gameover', highScore: this.highScore };
    else if (this.screen === 'hiscore') this.scene.presentation = { kind: 'hiscore', highScore: this.highScore, tick: this.presentationTicks };
    else if (this.screen === 'loss') this.scene.presentation = { kind: 'game', lossBannerProgress: 1 - this.presentationTime / LOSS_TIME };
    else if (state && state.introTicks > 0) this.scene.presentation = {
      kind: 'intro', stage: state.stage, elapsedMs: (INTRO_TICKS - state.introTicks) * TICK_MS,
      paused: state.phase === 'paused',
    };
    else this.scene.presentation = { kind: 'game', paused: state?.phase === 'paused' };
  }
}

new BattleCityApp();
