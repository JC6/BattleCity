import Phaser from 'phaser';
import './styles.css';
import { GameEngine } from './core/engine';
import { GRID_SIZE, TICK_MS, normalizeStage } from './core/constants';
import { ENEMY_KINDS, ENEMY_SCORE, FORTRESS_CELLS } from './core/rules';
import { EMPTY_INPUT, Tile, type GameMode, type GameState, type PlayerCarry, type PlayerInput } from './core/types';
import { getLevel } from './data/levels';
import { ArenaScene, CANVAS_HEIGHT, CANVAS_WIDTH } from './game/arena';
import { GameAudio } from './platform/audio';
import { InputManager } from './platform/input';
import { storage } from './platform/storage';

type Screen = 'menu' | 'game' | 'score' | 'gameover' | 'editor';
const terrainNames = ['空地', '砖墙', '钢墙', '水面', '树林', '冰面'];
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="#" aria-label="回到主菜单"><span class="brand-mark">B<span>C</span></span><span>BATTLECITY<small>坦克大战 · 1985</small></span></a>
      <div class="header-right"><span class="high-score">HI-SCORE <strong id="high-score">020000</strong></span><button type="button" class="icon-button" id="sound-toggle" aria-label="关闭声音">♪</button></div>
    </header>
    <main class="game-layout">
      <section class="intro-copy"><span class="eyebrow">THE CLASSIC RETURNS</span><h1>守住基地。<br>再过一关。</h1><p>一辆坦克，一座基地。<br>那些熟悉的像素，<br>现在打开浏览器就能重温。</p><div class="intro-rule"></div><span class="edition">35 关 / 单人 / 双人合作 / 地图编辑</span></section>
      <section class="arcade" aria-label="坦克大战游戏">
        <div class="machine-top"><span><i class="status-light"></i><span id="machine-status">READY TO PLAY</span></span><button type="button" class="text-button" id="fullscreen">全屏 ↗</button></div>
        <div class="screen-bezel"><div class="screen-wrap"><div id="game-canvas"></div><div id="game-overlay" class="game-overlay"></div><span class="screen-corner tl"></span><span class="screen-corner tr"></span><span class="screen-corner bl"></span><span class="screen-corner br"></span></div></div>
        <div class="machine-bottom"><div><span class="tiny-label">STAGE</span><strong id="stage-label">01</strong></div><div><span class="tiny-label">PLAYER 1</span><strong id="p1-score">000000</strong></div><div id="p2-hud"><span class="tiny-label">PLAYER 2</span><strong id="p2-score">—</strong></div><button type="button" class="pause-button" id="pause" disabled>暂停 <span>ESC</span></button></div>
        <div id="editor-panel"></div>
        <div class="touch-controls" id="touch-controls" aria-label="触屏控制"><div class="direction-pad"><button data-control="up" aria-label="向上">▲</button><button data-control="left" aria-label="向左">◀</button><span class="pad-center"></span><button data-control="right" aria-label="向右">▶</button><button data-control="down" aria-label="向下">▼</button></div><div class="touch-caption">保护基地<br><small>移动与射击可同时操作</small></div><button class="fire-button" data-control="fire" aria-label="射击">FIRE<span>射击</span></button></div>
      </section>
      <aside class="field-guide"><span class="eyebrow">FIELD GUIDE</span><h2>上场之前</h2><div class="guide-row"><span class="guide-number">01</span><div><h3>保护你的基地</h3><p>消灭每关 20 辆敌方坦克。<br>基地被击毁，战斗立即失败。</p></div></div><div class="guide-row"><span class="guide-number">02</span><div><h3>别错过道具</h3><p>击中闪烁的敌人会出现道具。<br>星星升级火力，手雷清除敌人。</p></div></div><div class="guide-row"><span class="guide-number">03</span><div><h3>邀一位老朋友</h3><p>在同一台电脑上并肩防守。<br>友方子弹会让队友暂时失控。</p></div></div><div class="keyboard-guide"><span class="tiny-label">KEYBOARD</span><p><b class="player-yellow">1P</b><kbd>W A S D</kbd><span>移动</span><kbd>J</kbd><span>射击</span></p><p><b class="player-blue">2P</b><kbd>↑ ↓ ← →</kbd><span>移动</span><kbd>↵</kbd><span>射击</span></p><small>单人也可用方向键 + 空格 · ESC 暂停</small></div></aside>
    </main>
    <footer class="site-footer"><span>BUILT FOR THE LOVE OF THE GAME</span><span>原创像素绘制与音效 · 经典规则致敬</span></footer>
  </div>`;

class BattleCityApp {
  readonly scene = new ArenaScene();
  private engine: GameEngine | null = null;
  private screen: Screen = 'menu';
  private accumulator = 0;
  private hudTicks = 0;
  private selectedStage = 1;
  private custom = false;
  private editorSession = false;
  private draft: Tile[];
  private brush = Tile.Brick;
  private scoreTime = 0;
  private scoreSecond = 0;
  private volume = storage.get().volume;
  private lastVolume = this.volume || 0.3;
  private audio = new GameAudio(this.volume);
  private input = new InputManager(() => this.pauseToggle(), () => this.audio.unlock(),
    () => this.screen === 'game' && !!this.engine && ['intro', 'playing', 'paused'].includes(this.engine.state.phase));
  private overlay = document.querySelector<HTMLDivElement>('#game-overlay')!;
  private readonly elements = {
    highScore: document.querySelector<HTMLElement>('#high-score')!,
    stage: document.querySelector<HTMLElement>('#stage-label')!,
    p1: document.querySelector<HTMLElement>('#p1-score')!,
    p2: document.querySelector<HTMLElement>('#p2-score')!,
    p2Hud: document.querySelector<HTMLElement>('#p2-hud')!,
    pause: document.querySelector<HTMLButtonElement>('#pause')!,
    status: document.querySelector<HTMLElement>('#machine-status')!,
    touch: document.querySelector<HTMLElement>('#touch-controls')!,
    editor: document.querySelector<HTMLElement>('#editor-panel')!,
  };
  constructor() {
    this.draft = storage.get().map ?? this.emptyMap();
    this.scene.onFrame = delta => this.frame(delta);
    this.scene.onPaint = (x, y) => this.paint(x, y);
    new Phaser.Game({
      type: Phaser.AUTO, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
      parent: 'game-canvas', backgroundColor: '#101712', pixelArt: true,
      roundPixels: true, antialias: false, scene: [this.scene],
      audio: { noAudio: true },
      // The rules own their fixed clock. Phaser's default smoothing clamps
      // slow rendering frames and would make a 30Hz browser run at half speed.
      fps: { smoothStep: false },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
    this.input.attachTouch(this.elements.touch);
    const syncCanvasInput = () => {
      if (!this.scene.draft) return;
      const scale = this.scene.scale;
      if (!scale?.canvas) return;
      const { width, height } = scale.parentSize;
      scale.getParentBounds();
      if (scale.parentSize.width !== width || scale.parentSize.height !== height) scale.refresh();
      else scale.updateBounds();
    };
    // Run before Phaser converts DOM input after an editor layout change.
    const canvasRoot = document.querySelector<HTMLElement>('#game-canvas')!;
    for (const event of ['mousedown', 'mousemove', 'touchstart', 'touchmove']) {
      canvasRoot.addEventListener(event, syncCanvasInput, { capture: true, passive: true });
    }
    app.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (!action) return;
      this.audio.unlock();
      switch (action) {
        case 'single': this.start('single', this.selectedStage); break;
        case 'coop': this.start('coop', this.selectedStage); break;
        case 'editor': this.openEditor(); break;
        case 'resume': this.resume(); break;
        case 'menu': this.menu(); break;
        case 'next': this.advance(); break;
        case 'retry': if (this.engine) this.start(this.engine.state.mode, this.engine.state.stage, undefined, this.custom, this.editorSession); break;
        case 'edit-return': this.openEditor(); break;
        case 'edit-single': this.playEditor('single'); break;
        case 'edit-coop': this.playEditor('coop'); break;
        case 'edit-retry': if (this.engine) this.playEditor(this.engine.state.mode); break;
        case 'edit-clear': this.draft = this.emptyMap(); this.saveDraft(); this.scene.draft = this.draft; break;
        default:
          if (action.startsWith('brush-')) {
            this.brush = Number(action.slice(6)) as Tile;
            app.querySelectorAll('[data-action^="brush-"]').forEach(button => button.classList.toggle('selected', (button as HTMLElement).dataset.action === action));
          }
      }
    });
    app.addEventListener('change', event => {
      const element = event.target as HTMLSelectElement;
      if (element.id === 'stage-select') { this.selectedStage = Number(element.value); this.updateHud(); }
    });
    document.querySelector('.brand')!.addEventListener('click', event => { event.preventDefault(); this.menu(); });
    this.elements.pause.addEventListener('click', () => this.pauseToggle());
    document.querySelector('#sound-toggle')!.addEventListener('click', () => {
      this.audio.unlock();
      this.applyVolume(this.volume ? 0 : this.lastVolume);
      storage.volume(this.volume);
    });
    document.querySelector('#fullscreen')!.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      else void document.querySelector<HTMLElement>('.arcade')!.requestFullscreen?.().catch(() => {});
    });
    const inactive = () => {
      if (this.screen !== 'game' || !this.pause()) { this.input.clear(); this.accumulator = 0; }
      this.scene.input?.resetPointers();
    };
    window.addEventListener('blur', inactive);
    window.addEventListener('pagehide', () => this.persistHighScore());
    window.addEventListener('storage', event => {
      const changed = storage.handleStorageEvent(event);
      const volume = storage.get().volume;
      if (volume !== this.volume) this.applyVolume(volume);
      if (changed) this.updateHud();
    });
    // Capture nested fullscreen scrolling before the next canvas input.
    document.addEventListener('scroll', () => this.scene.scale?.updateBounds(), true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) inactive(); });
    this.applyVolume(this.volume); this.menu();
    if (import.meta.env.MODE === 'test') {
      const snapshot = (): GameState | null => this.engine ? structuredClone(this.engine.state) : null;
      Object.assign(window, { __BATTLECITY__: {
        state: snapshot,
        start: (mode: GameMode = 'single', stage = 1) => this.start(mode, stage),
        step: (count = 1, inputs: PlayerInput[] = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }]): void => {
          if (!this.engine) return;
          for (let index = 0; index < Math.min(10000, Math.max(0, count)); index++) this.engine.step(inputs);
          if (this.screen === 'game' && ['won', 'lost'].includes(this.engine.state.phase)) { this.showScore(); return; }
          this.updateHud();
        },
        debug: (patch: Partial<GameState>) => {
          if (this.engine) Object.assign(this.engine.state, patch);
        },
        openEditor: () => this.openEditor(),
        setEditorTile: (index: number, tile: Tile) => {
          if (!Number.isInteger(index) || index < 0 || index >= GRID_SIZE * GRID_SIZE || !Number.isInteger(tile) || tile < Tile.Empty || tile > Tile.Ice) return;
          if (this.protected(index % GRID_SIZE, Math.floor(index / GRID_SIZE)) || this.draft[index] === tile) return;
          this.draft[index] = tile; this.saveDraft();
        },
        getEditorTiles: () => [...this.draft],
        playEditor: (mode: GameMode = 'single') => this.playEditor(mode),
      } });
    }
  }
  start(mode: GameMode, stage: number, carries?: PlayerCarry[], custom = false, editorSession = false): void {
    stage = normalizeStage(stage);
    this.persistHighScore();
    this.input.clear(); this.audio.unlock();
    this.custom = custom; this.editorSession = editorSession;
    const level = getLevel(stage);
    if (custom) level.tiles = this.draft;
    this.engine = new GameEngine(level, { mode, stage, seed: crypto.getRandomValues(new Uint32Array(1))[0], ...(carries ? { players: carries } : {}) });
    this.screen = 'game'; this.accumulator = 0; this.hudTicks = 0;
    this.scene.draft = null; this.scene.state = this.engine.state;
    this.input.mode = mode; this.input.active = true;
    this.overlay.className = 'game-overlay';
    this.elements.editor.innerHTML = '';
    this.overlay.innerHTML = `<div class="stage-intro"><span class="tiny-label">${custom ? 'YOUR BATTLEFIELD' : 'DEFEND THE BASE'}</span><h2>STAGE ${String(stage).padStart(2, '0')}</h2><p>${mode === 'coop' ? '并肩作战 · 守住基地' : '准备出击 · 守住基地'}</p></div>`;
    this.updateHud();
    this.elements.touch.classList.toggle('coop', mode === 'coop');
  }
  menu(): void {
    this.persistHighScore();
    this.custom = false; this.editorSession = false;
    this.screen = 'menu'; this.engine = null; this.scene.state = null; this.scene.draft = null;
    this.input.active = false; this.input.clear(); this.accumulator = 0;
    this.overlay.className = 'game-overlay menu-overlay';
    this.elements.editor.innerHTML = '';
    this.overlay.innerHTML = `<div class="menu-content"><span class="menu-kicker">INSERT MEMORIES</span><h2 class="game-title">BATTLE<br><span>CITY</span></h2><p class="menu-subtitle">坦 克 大 战</p><div class="stage-picker"><label for="stage-select">从这里出发</label><select id="stage-select" aria-label="选择关卡">${Array.from({ length: 35 }, (_, index) => `<option value="${index + 1}" ${index + 1 === this.selectedStage ? 'selected' : ''}>STAGE ${String(index + 1).padStart(2, '0')}</option>`).join('')}</select></div><div class="menu-actions"><button class="primary-action" data-action="single"><span>▶</span> 单人出击 <small>1 PLAYER</small></button><button data-action="coop"><span>▶</span> 双人合作 <small>2 PLAYERS</small></button><button data-action="editor"><span>◇</span> 地图编辑 <small>CONSTRUCTION</small></button></div><p class="menu-note">双人合作需要同一台电脑与键盘</p></div>`;
    this.updateHud();
  }
  openEditor(): void {
    this.persistHighScore();
    this.custom = false; this.editorSession = false;
    this.screen = 'editor'; this.engine = null; this.scene.state = null; this.scene.draft = this.draft;
    this.input.active = false; this.input.clear(); this.accumulator = 0;
    this.overlay.className = 'game-overlay';
    this.overlay.innerHTML = '<div class="editor-header"><span>CONSTRUCTION</span><button data-action="menu" class="text-button">返回菜单</button></div>';
    this.elements.editor.innerHTML = `<div class="editor-tools"><div class="terrain-palette">${terrainNames.map((name, index) => `<button data-action="brush-${index}" class="terrain-${index} ${index === this.brush ? 'selected' : ''}" aria-label="绘制${name}"><i></i>${name}</button>`).join('')}</div><div class="editor-actions"><button data-action="edit-clear">清空</button><button data-action="edit-single" class="primary-action">单人试玩 ▶</button><button data-action="edit-coop">双人试玩 ▶</button></div><p>点击或拖动绘制 · 基地与出生区保留 · 地图自动保存<br>编辑地图用于起始关，过关后继续原版关卡</p></div>`;
    this.updateHud();
  }
  playEditor(mode: GameMode): void { this.start(mode, this.selectedStage, undefined, true, true); }
  pause(): boolean {
    if (this.screen !== 'game' || !this.engine || !['intro', 'playing'].includes(this.engine.state.phase)) return false;
    this.engine.setPaused(true); this.input.active = false; this.input.clear(); this.accumulator = 0;
    this.overlay.className = 'game-overlay pause-overlay';
    this.overlay.innerHTML = `<div class="dialog"><span class="menu-kicker">TAKE A BREATH</span><h2>战斗暂停</h2><p>休息一下，基地等你回来。</p><button class="primary-action" data-action="resume">继续战斗 ▶</button>${this.editorSession ? '<button data-action="edit-return">返回编辑</button><button data-action="edit-retry">重新试玩</button>' : ''}<button data-action="menu">返回主菜单</button></div>`;
    this.updateHud();
    return true;
  }
  resume(): void {
    if (!this.engine || this.screen !== 'game' || this.engine.state.phase !== 'paused') return;
    this.audio.unlock(); this.engine.setPaused(false); this.input.clear(); this.input.active = true; this.accumulator = 0;
    this.overlay.className = 'game-overlay'; this.overlay.innerHTML = ''; this.updateHud();
  }
  pauseToggle(): void { if (this.engine?.state.phase === 'paused') this.resume(); else this.pause(); }
  private frame(delta: number): void {
    if (this.screen === 'score') {
      if (!document.hidden && document.hasFocus()) this.scoreTime = Math.max(0, this.scoreTime - Math.min(delta, 100));
      const second = Math.ceil(this.scoreTime / 1000);
      if (second !== this.scoreSecond) {
        this.scoreSecond = second;
        const countdown = document.querySelector('#next-countdown');
        if (countdown) countdown.textContent = `${second} 秒后继续`;
      }
      if (!this.scoreTime) this.advance();
      return;
    }
    if (this.screen !== 'game' || !this.engine || this.engine.state.phase === 'paused') { this.accumulator = 0; return; }
    this.accumulator += Math.min(delta, 100);
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps++ < 6) {
      this.audio.play(this.engine.step(this.input.read()));
      this.accumulator -= TICK_MS;
      if (this.engine.state.phase === 'won' || this.engine.state.phase === 'lost') { this.showScore(); return; }
    }
    if (this.engine.state.phase === 'playing' && this.overlay.querySelector('.stage-intro')) this.overlay.innerHTML = '';
    if (++this.hudTicks % 8 === 0) this.updateHud();
  }
  private showScore(): void {
    const state = this.engine!.state;
    this.screen = 'score'; this.input.active = false; this.input.clear(); this.accumulator = 0;
    this.scoreTime = state.phase === 'won' ? 6000 : 3500;
    this.scoreSecond = Math.ceil(this.scoreTime / 1000);
    this.overlay.className = 'game-overlay score-overlay';
    this.overlay.innerHTML = `<div class="score-content"><span class="menu-kicker">${state.phase === 'won' ? 'MISSION COMPLETE' : 'BATTLE REPORT'}</span><h2>${state.phase === 'won' ? '基地守住了！' : '战斗结束'}</h2><span class="score-stage">STAGE ${String(state.stage).padStart(2, '0')}</span><div class="score-grid"><div class="score-head"><span>敌方坦克</span>${state.players.map((_, index) => `<span class="${index ? 'player-blue' : 'player-yellow'}">${index + 1}P</span>`).join('')}</div>${['普通', '高速', '速射', '装甲'].map((name, index) => `<div><span>${name}<small>${ENEMY_SCORE[ENEMY_KINDS[index]!]} PTS</small></span>${state.players.map(player => `<strong>${player.kills[index]}<small>${player.kills[index] * ENEMY_SCORE[ENEMY_KINDS[index]!]}</small></strong>`).join('')}</div>`).join('')}<div class="score-total"><span>TOTAL</span>${state.players.map(player => `<strong>${String(player.score).padStart(6, '0')}</strong>`).join('')}</div></div><button class="primary-action" data-action="next">${state.phase === 'won' ? '进入下一关 ▶' : '查看结果 ▶'}</button>${this.editorSession ? '<div class="score-extra-actions"><button data-action="edit-return">返回编辑 ◇</button><button data-action="edit-retry">重新试玩 ▶</button></div>' : ''}<p id="next-countdown">${this.scoreSecond} 秒后继续</p></div>`;
    this.updateHud();
  }
  private advance(): void {
    if (!this.engine) return;
    const state = this.engine.state;
    if (state.phase === 'lost') {
      this.screen = 'gameover'; this.scoreTime = 0;
      this.overlay.className = 'game-overlay gameover-overlay';
      this.overlay.innerHTML = `<div class="dialog"><span class="menu-kicker">ONE MORE TRY?</span><h2>GAME<br><span>OVER</span></h2><p>${state.baseAlive ? '所有坦克都已损失。' : '基地被击毁了。'}<br>下一次，一定能守住。</p><button class="primary-action" data-action="retry">重试这一关 ▶</button>${this.editorSession ? '<button data-action="edit-return">返回编辑</button><button data-action="edit-retry">重新试玩</button>' : ''}<button data-action="menu">返回主菜单</button></div>`;
      this.updateHud();
    } else {
      const players = state.players.map(({ score, lives, stars, nextExtraLife, eliminated }) => ({ score, lives, stars, nextExtraLife, eliminated }));
      this.start(state.mode, state.stage === 70 ? 1 : state.stage + 1, players, false, this.editorSession);
    }
  }
  private updateHud(): void {
    const state = this.engine?.state;
    const setText = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
    setText(this.elements.highScore, String(this.persistHighScore()).padStart(6, '0'));
    setText(this.elements.stage, this.screen === 'editor' ? 'EDIT' : String(state?.stage ?? this.selectedStage).padStart(2, '0'));
    setText(this.elements.p1, String(state?.players[0]?.score ?? 0).padStart(6, '0'));
    setText(this.elements.p2, state?.players[1] ? String(state.players[1].score).padStart(6, '0') : '—');
    this.elements.p2Hud.classList.toggle('active', !!state?.players[1]);
    const pause = this.elements.pause;
    const disabled = this.screen !== 'game';
    if (pause.disabled !== disabled) pause.disabled = disabled;
    const pauseLabel = state?.phase === 'paused' ? '继续 <span>ESC</span>' : '暂停 <span>ESC</span>';
    if (pause.innerHTML !== pauseLabel) pause.innerHTML = pauseLabel;
    const labels: Record<Screen, string> = { menu: 'READY TO PLAY', game: state?.phase === 'paused' ? 'PAUSED' : this.custom ? 'CUSTOM BATTLE' : state?.mode === 'coop' ? 'CO-OP MISSION' : 'SINGLE PLAYER', editor: 'CREATE YOUR BATTLEFIELD', score: 'BATTLE REPORT', gameover: 'GAME OVER' };
    setText(this.elements.status, labels[this.screen]);
    this.elements.touch.classList.toggle('playing', this.screen === 'game' && state?.phase !== 'paused');
  }
  private persistHighScore(): number {
    const highScore = storage.getHighScore();
    const score = Math.max(0, ...(this.engine?.state.players.map(player => player.score) ?? []));
    return score > highScore ? storage.highScore(score) : highScore;
  }
  private applyVolume(volume: number): void {
    this.volume = volume;
    if (volume > 0) this.lastVolume = volume;
    this.audio.setVolume(volume);
    const button = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
    button.textContent = this.volume ? '♪' : '♪̸';
    button.setAttribute('aria-label', this.volume ? '关闭声音' : '开启声音');
    button.setAttribute('aria-pressed', String(!!this.volume));
  }
  private emptyMap(): Tile[] {
    const tiles = Array<Tile>(GRID_SIZE * GRID_SIZE).fill(Tile.Empty);
    for (const index of FORTRESS_CELLS) tiles[index] = Tile.Brick;
    return tiles;
  }
  private protected(x: number, y: number): boolean {
    return (y >= 24 && (x === 8 || x === 9 || x === 12 || x === 13 || x === 16 || x === 17)) || (y < 2 && (x < 2 || x === 12 || x === 13 || x >= 24));
  }
  private paint(x: number, y: number): void {
    const ox = x & ~1, oy = y & ~1;
    let changed = false;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = ox + dx, py = oy + dy;
      const index = py * GRID_SIZE + px;
      if (!this.protected(px, py) && this.draft[index] !== this.brush) { this.draft[index] = this.brush; changed = true; }
    }
    if (changed) this.saveDraft();
  }
  private saveDraft(): void { storage.map(this.draft); }
}

new BattleCityApp();
