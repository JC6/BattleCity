import type { ArenaPresentation } from '../app/presentation';
import Phaser from 'phaser';
import { ARENA_SIZE, BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE } from '../core/constants';
import { Tile, type GameState } from '../core/types';
import { ENEMY_KINDS } from '../core/rules';
import { GAMEOVER_BRICKS, HISCORE_PALETTES, NAMCOT, PALETTE, PLAYER,
  SCORE_ENEMIES, directionalBitmap, drawBitmap, drawBrickWord, drawText, type PixelSurface } from './pixel-assets';
import { TankAnimation } from './animation';
import { scoreTimeline } from './score-timeline';
import { NativeAtlas, tankFrame, tileFrame } from './atlas';
import { NativeTexture } from './textures';

export const CANVAS_WIDTH = 256;
export const CANVAS_HEIGHT = 240;
export const ARENA_OFFSET = { x: 16, y: 16 };

// Title fields start at score + 1 in the original seven-digit counter.
function menuScore(score: number): string {
  const visible = score % 1_000_000;
  return visible === 0 ? '00' : String(visible);
}

export type { ArenaPresentation } from '../app/presentation';

type Image = Phaser.GameObjects.Image;
function show(image: Image, key: string, frame: string | undefined, x: number, y: number, depth: number): void {
  if (image.texture.key !== key || (frame !== undefined && image.frame.name !== frame)) image.setTexture(key, frame);
  image.setPosition(x, y).setVisible(true);
  if (image.depth !== depth) image.setDepth(depth);
}

/** Slots grow only to simultaneous demand; cumulative core ids never allocate images. */
class ImagePool {
  private images: Image[] = [];
  private used = 0;
  constructor(private scene: Phaser.Scene, private atlas: NativeAtlas) {}
  begin(): void { this.used = 0; }
  draw(frame: string, x: number, y: number, depth: number): void {
    let image = this.images[this.used];
    if (!image) {
      image = this.scene.add.image(0, 0, this.atlas.key, frame).setOrigin(0);
      this.images.push(image);
    }
    show(image, this.atlas.key, frame, x, y, depth); this.used++;
  }
  finish(): void { for (let i = this.used; i < this.images.length; i++) this.images[i].setVisible(false); }
  hide(): void { this.begin(); this.finish(); }
  destroy(): void { for (const image of this.images) image.destroy(); this.images = []; this.used = 0; }
}

export class ArenaScene extends Phaser.Scene {
  state: Readonly<GameState> | null = null;
  // The loss world can animate while these authoritative HUD values stay locked.
  hudState: Readonly<GameState> | null = null;
  draft: readonly Tile[] | null = null;
  presentation: ArenaPresentation = { kind: 'menu', selection: 0, highScore: 20000, playerScores: [] };
  onFrame: (delta: number) => void = () => {};
  private atlas?: NativeAtlas;
  private maps: NativeTexture[] = [];
  private forest!: NativeTexture;
  private hud!: NativeTexture;
  private staticPage!: NativeTexture;
  private hiscorePages: NativeTexture[] = [];
  private ownedTextures: NativeTexture[] = [];
  private fixedImages: Image[] = [];
  private background!: Image;
  private mapImage!: Image;
  private forestImage!: Image;
  private hudImage!: Image;
  private pageImage!: Image;
  private baseImage!: Image;
  private itemImage!: Image;
  private cursorImage!: Image;
  private pauseImage!: Image;
  private lossImage!: Image;
  private covers: Image[] = [];
  private tanks!: ImagePool;
  private bullets!: ImagePool;
  private explosions!: ImagePool;
  private points!: ImagePool;
  private tileKeys = new Int16Array(GRID_SIZE * GRID_SIZE).fill(-1);
  private hudKey: string | null = null;
  private staticKey: string | null = null;
  private hiscoreKeys: (number | null)[] = [null, null, null, null];
  private animation = new TankAnimation();
  constructor() { super('arena'); }

  create(): void {
    // Canvas batchSprite expands images by 0.5px when camera.roundPixels is true.
    // Origins, positions and sizes below already use the native integer grid.
    if (this.game.renderer.type === Phaser.CANVAS) this.cameras.main.roundPixels = false;
    this.atlas = new NativeAtlas(this, 'arena-atlas');
    this.ownedTextures = [this.atlas];
    const texture = (key: string, width: number, height: number) => {
      const result = new NativeTexture(this, key, width, height); this.ownedTextures.push(result); return result;
    };
    const page = (key: string) => {
      const result = NativeTexture.createPage(this, key, CANVAS_WIDTH, CANVAS_HEIGHT); this.ownedTextures.push(result); return result;
    };
    this.maps = [0, 1].map(phase => texture(`arena-map-${phase}`, ARENA_SIZE, ARENA_SIZE));
    this.maps.forEach(map => map.clear(PALETTE.black));
    this.forest = texture('arena-forest', ARENA_SIZE, ARENA_SIZE);
    this.hud = texture('arena-hud', 32, ARENA_SIZE);
    this.staticPage = page('arena-page');
    this.hiscorePages = [0, 1, 2, 3].map(phase => page(`arena-hiscore-${phase}`));
    const image = (key: string, frame?: string) => {
      const result = this.add.image(0, 0, key, frame).setOrigin(0).setVisible(false);
      this.fixedImages.push(result); return result;
    };
    this.background = image(this.atlas.key, 'gray').setDisplaySize(CANVAS_WIDTH, CANVAS_HEIGHT);
    this.mapImage = image(this.maps[0].key); this.forestImage = image(this.forest.key);
    this.hudImage = image(this.hud.key); this.pageImage = image(this.staticPage.key);
    this.baseImage = image(this.atlas.key, 'base:alive'); this.itemImage = image(this.atlas.key, 'item:star');
    this.cursorImage = image(this.atlas.key, 'player:0:0:up:0');
    this.pauseImage = image(this.atlas.key, 'pause'); this.lossImage = image(this.atlas.key, 'loss');
    this.covers = [image(this.atlas.key, 'gray'), image(this.atlas.key, 'gray')];
    this.tanks = new ImagePool(this, this.atlas); this.bullets = new ImagePool(this, this.atlas);
    this.explosions = new ImagePool(this, this.atlas); this.points = new ImagePool(this, this.atlas);
    this.tileKeys.fill(-1); this.hudKey = this.staticKey = null; this.hiscoreKeys.fill(null);
    this.events.once('shutdown', this.releaseResources, this);
    this.events.once('destroy', this.releaseResources, this);
  }
  observeStep(state: GameState): void { this.animation.observe(state); }
  resetAnimation(): void { this.animation.reset(); }

  update(_time: number, delta: number): void {
    this.onFrame(delta);
    if (!this.atlas) return;
    for (const image of this.fixedImages) image.setVisible(false);
    const presentation = this.presentation;
    const isPage = ['menu', 'stage-select', 'score', 'gameover', 'hiscore'].includes(presentation.kind);
    if (isPage || (presentation.kind === 'intro' && presentation.elapsedMs < 1000)) {
      this.tanks.hide(); this.bullets.hide(); this.explosions.hide(); this.points.hide();
    }
    if (isPage) {
      this.renderPage(presentation); return;
    }
    if (presentation.kind === 'intro' && presentation.elapsedMs < 1000) {
      // An opaque intro has no visible world. Simulation and animation history
      // continue above, and the first revealed frame synchronizes current tiles.
      this.renderStage(presentation.stage);
    } else {
      this.renderWorld();
      if (presentation.kind === 'intro') {
        const cover = Math.max(0, Math.ceil(120 * (2000 - presentation.elapsedMs) / 1000));
        if (cover > 0) this.covers.forEach((image, index) => {
          show(image, this.atlas!.key, 'gray', 0, index ? CANVAS_HEIGHT - cover : 0, 800 + index);
          image.setDisplaySize(CANVAS_WIDTH, cover);
        });
      }
    }
    if ((presentation.kind === 'game' || presentation.kind === 'intro') && presentation.paused) {
      show(this.pauseImage, this.atlas.key, 'pause', 88, 112, 1000);
    }
  }

  private renderWorld(): void {
    const atlas = this.atlas!;
    const state = this.state, tick = state?.tick ?? 0;
    const tiles = this.draft ?? state?.tiles;
    this.syncTiles(tiles, this.draft ? undefined : state?.brickMasks);
    show(this.background, atlas.key, 'gray', 0, 0, 0);
    show(this.mapImage, this.maps[Math.floor(tick / 16) % 2].key, undefined, 16, 16, 1);
    show(this.forestImage, this.forest.key, undefined, 16, 16, 400);
    const presentation = this.presentation;
    if (presentation.kind !== 'editor' || presentation.baseVisible !== false) {
      show(this.baseImage, atlas.key, state?.baseAlive === false ? 'base:dead' : 'base:alive',
        ARENA_OFFSET.x + BASE_X, ARENA_OFFSET.y + BASE_Y, 10);
    }
    this.tanks.begin(); this.bullets.begin(); this.explosions.begin(); this.points.begin();
    if (state) {
      state.tanks.forEach((tank, index) => {
        const x = ARENA_OFFSET.x + Math.round(tank.x), y = ARENA_OFFSET.y + Math.round(tank.y);
        if (tank.spawnTicks > 0) {
          const phase = Math.floor((28 - Math.min(28, tank.spawnTicks)) / 3) % 3;
          this.tanks.draw(`spawn:${phase}`, x, y, 20 + index * 2);
        } else {
          this.tanks.draw(tankFrame(tank, this.animation.frame(tank), tick), x, y, 20 + index * 2);
          if (tank.shieldTicks > 0 && tick % 12 < 7) this.tanks.draw('shield', x, y, 21 + index * 2);
        }
      });
      state.bullets.forEach((bullet, index) => {
        const impact = bullet.impactTicks;
        this.bullets.draw(impact ? `impact:${Math.min(2, Math.floor((9 - impact) / 3))}` : `bullet:${bullet.direction}`,
          ARENA_OFFSET.x + Math.round(bullet.x) - (impact ? 4 : 2),
          ARENA_OFFSET.y + Math.round(bullet.y) - (impact ? 4 : 2), 100 + index);
      });
      if (state.powerUp && tick % 32 < 24) show(this.itemImage, atlas.key, `item:${state.powerUp.kind}`,
        ARENA_OFFSET.x + state.powerUp.x, ARENA_OFFSET.y + state.powerUp.y, 200);
      let explosions = 0, glyphs = 0;
      state.effects.forEach(effect => {
        if (effect.kind === 'explosion') {
          const phase = Math.min(2, Math.floor((24 - Math.min(24, effect.remainingTicks)) / 8));
          const frame = `explosion:${effect.explosionVariant === 'base' ? Math.max(1, phase) : phase}`;
          const size = atlas.frames.get(frame)!;
          this.explosions.draw(frame, ARENA_OFFSET.x + Math.round(effect.x) - size.width / 2,
            ARENA_OFFSET.y + Math.round(effect.y) - size.height / 2, 300 + explosions++);
        } else {
          const text = String(effect.value ?? 0);
          [...text].forEach((char, index) => this.points.draw(`glyph:${char}`,
            ARENA_OFFSET.x + Math.round(effect.x) - text.length * 4 + index * 8,
            ARENA_OFFSET.y + Math.round(effect.y) - 4, 500 + glyphs++));
        }
      });
    }
    this.tanks.finish(); this.bullets.finish(); this.explosions.finish(); this.points.finish();
    if (this.draft && presentation.kind === 'editor' && presentation.cursor) show(this.cursorImage, atlas.key, 'player:0:0:up:0',
      ARENA_OFFSET.x + presentation.cursor.x * TILE_SIZE, ARENA_OFFSET.y + presentation.cursor.y * TILE_SIZE, 600);
    this.renderHud(this.hudState ?? state);
    if (presentation.kind === 'game' && presentation.lossBannerProgress !== undefined) {
      show(this.lossImage, atlas.key, 'loss', 96, Math.round(208 - Math.max(0, Math.min(1, presentation.lossBannerProgress)) * 104), 900);
    }
  }

  private syncTiles(tiles: readonly Tile[] | undefined, masks: readonly number[] | undefined): void {
    let changed = false, forestChanged = false;
    for (let index = 0; index < this.tileKeys.length; index++) {
      const tile = tiles?.[index] ?? Tile.Empty;
      const mask = tile === Tile.Brick ? (masks?.[index] ?? 15) & 15 : 0;
      const key = tile * 16 + mask;
      const previous = this.tileKeys[index];
      if (previous === key) continue;
      const x = index % GRID_SIZE * TILE_SIZE, y = Math.floor(index / GRID_SIZE) * TILE_SIZE;
      this.maps.forEach((map, phase) => {
        map.pixels.fillStyle(PALETTE.black).fillRect(x, y, TILE_SIZE, TILE_SIZE);
        const frame = tile !== Tile.Forest ? tileFrame(tile, mask, phase) : null;
        if (frame) this.atlas!.draw(map, frame, x, y);
      });
      if (tile === Tile.Forest || (previous >= 0 && Math.floor(previous / 16) === Tile.Forest)) {
        this.forest.texture.context.clearRect(x, y, TILE_SIZE, TILE_SIZE);
        if (tile === Tile.Forest) this.atlas!.draw(this.forest, 'forest', x, y);
        forestChanged = true;
      }
      this.tileKeys[index] = key; changed = true;
    }
    if (changed) this.maps.forEach(map => map.refresh());
    if (forestChanged) this.forest.refresh();
  }

  private renderHud(state: GameState | null): void {
    const remaining = state ? Math.max(0, state.enemyQueue.length - state.spawned) : 20;
    const players = state?.players ?? [{ lives: 2 }];
    const stage = state?.stage ?? 1;
    const key = JSON.stringify([remaining, players.map(player => player.lives), stage]);
    if (key !== this.hudKey) {
      this.hud.clear();
      const g = this.hud.pixels;
      for (let i = 0; i < remaining; i++) this.atlas!.draw(this.hud, 'enemy-icon', 8 + i % 2 * 8, 8 + Math.floor(i / 2) * 8);
      players.forEach((player, index) => {
        const y = 120 + index * 24;
        drawText(g, index ? 'II' : 'IP', 8, y, PALETTE.black);
        this.atlas!.draw(this.hud, `life:${index}`, 8, y + 8);
        drawText(g, String(player.lives), 16, y + 8, PALETTE.black);
      });
      this.atlas!.draw(this.hud, 'flag', 8, 168);
      const label = String(stage); drawText(g, label, 24 - label.length * 8, 184, PALETTE.black);
      this.hud.refresh(); this.hudKey = key;
    }
    show(this.hudImage, this.hud.key, undefined, 224, 16, 700);
  }

  private renderStage(stage: number): void {
    const key = `stage:${stage}`;
    if (this.staticKey !== key) {
      this.staticPage.paint(g => {
        g.fillStyle(PALETTE.gray); g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        const label = `STAGE ${stage}`;
        drawText(g, label, Math.floor((CANVAS_WIDTH - label.length * 8) / 2), 120, PALETTE.black);
      });
      this.staticKey = key;
    }
    show(this.pageImage, this.staticPage.key, undefined, 0, 0, 800);
  }

  private renderPage(presentation: ArenaPresentation): void {
    if (presentation.kind === 'stage-select') { this.renderStage(presentation.stage); return; }
    if (presentation.kind === 'hiscore') {
      // Direct or unusually brief transitions still finish any unprepared pages.
      for (let phase = 0; phase < 4; phase++) this.prepareHiscorePage(presentation.highScore, phase);
      show(this.pageImage, this.hiscorePages[presentation.tick & 3].key, undefined, 0, 0, 800); return;
    }
    const key = presentation.kind === 'menu' ? JSON.stringify(['menu', presentation.selection,
      menuScore(presentation.highScore), menuScore(presentation.playerScores[0] ?? 0),
      presentation.playerScores.length > 1 ? menuScore(presentation.playerScores[1] ?? 0) : null]) : presentation.kind === 'gameover' ? 'gameover' :
      presentation.kind === 'score' ? JSON.stringify(['score', presentation.state.stage, presentation.highScore,
        scoreTimeline(presentation.state, presentation.elapsedMs), presentation.state.players.map(player => [player.index, player.score])]) : null;
    if (key === null) return;
    if (key !== this.staticKey) {
      this.staticPage.paint(g => {
        if (presentation.kind === 'menu') this.menu(g, presentation);
        else if (presentation.kind === 'score') this.score(g, presentation);
        else if (presentation.kind === 'gameover') {
          g.fillStyle(PALETTE.black); g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          drawBrickWord(g, 'GAME', 60, 72, false, 4, GAMEOVER_BRICKS);
          drawBrickWord(g, 'OVER', 60, 124, false, 4, GAMEOVER_BRICKS);
        }
      });
      this.staticKey = key;
    } else if (presentation.kind === 'gameover' && presentation.highScore !== undefined && this.state) {
      const highScore = Math.max(presentation.highScore, ...this.state.players.map(player => player.score));
      // Only a beaten record enters HISCORE. Prepare at most one invisible page
      // per later GAME OVER render, leaving its first paint and music untouched.
      if (highScore > presentation.highScore) {
        const phase = this.hiscoreKeys.findIndex(score => score !== highScore);
        if (phase !== -1) this.prepareHiscorePage(highScore, phase);
      }
    }
    show(this.pageImage, this.staticPage.key, undefined, 0, 0, 800);
  }

  private prepareHiscorePage(highScore: number, phase: number): void {
    if (this.hiscoreKeys[phase] === highScore) return;
    const page = this.hiscorePages[phase], label = String(highScore);
    page.paint(g => {
      g.fillStyle(PALETTE.black); g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      drawBrickWord(g, 'HISCORE', 16, 48, false, 4, HISCORE_PALETTES[phase]);
      drawBrickWord(g, label, Math.floor((CANVAS_WIDTH - label.length * 32) / 2), 104, false, 4, HISCORE_PALETTES[phase]);
    });
    this.hiscoreKeys[phase] = highScore;
  }

  private releaseResources(): void {
    if (!this.atlas) return;
    this.events.off('shutdown', this.releaseResources, this);
    this.events.off('destroy', this.releaseResources, this);
    this.tanks.destroy(); this.bullets.destroy(); this.explosions.destroy(); this.points.destroy();
    for (const image of this.fixedImages) image.destroy();
    for (const texture of this.ownedTextures) this.textures.remove(texture.key);
    this.fixedImages = []; this.ownedTextures = []; this.maps = []; this.hiscorePages = []; this.covers = [];
    // A stopped scene can stay in SceneManager. Drop canvas contexts and pooled
    // texture references as well as their TextureManager registrations.
    this.forest = this.hud = this.staticPage = undefined!;
    this.background = this.mapImage = this.forestImage = this.hudImage = this.pageImage = undefined!;
    this.baseImage = this.itemImage = this.cursorImage = this.pauseImage = this.lossImage = undefined!;
    this.tanks = this.bullets = this.explosions = this.points = undefined!;
    this.atlas = undefined; this.tileKeys.fill(-1); this.hudKey = this.staticKey = null; this.hiscoreKeys.fill(null);
    this.animation.reset();
  }
  private menu(g: PixelSurface, presentation: Extract<ArenaPresentation, { kind: 'menu' }>): void {
    g.fillStyle(PALETTE.black); g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const playerScore = menuScore(presentation.playerScores[0] ?? 0), highScore = menuScore(presentation.highScore);
    drawText(g, 'I-', 16, 24); drawText(g, playerScore, 80 - playerScore.length * 8, 24);
    drawText(g, 'HI-', 88, 24); drawText(g, highScore, 160 - highScore.length * 8, 24);
    if (presentation.playerScores.length > 1) {
      const playerTwoScore = menuScore(presentation.playerScores[1] ?? 0);
      drawText(g, 'Ⅱ-', 168, 24); drawText(g, playerTwoScore, 232 - playerTwoScore.length * 8, 24);
    }
    drawBrickWord(g, 'BATTLE', 24, 48); drawBrickWord(g, 'CITY', 64, 88, true);
    ['1 PLAYER', '2 PLAYERS', 'CONSTRUCTION'].forEach((text, i) => drawText(g, text, 88, 136 + i * 16));
    drawBitmap(g, directionalBitmap(PLAYER, 'right'), 64, 132 + presentation.selection * 16, { Y: PALETTE.yellow, D: PALETTE.olive });
    drawBitmap(g, NAMCOT, 88, 184, { '1': PALETTE.red });
    drawText(g, '©', 32, 200); drawText(g, '1980 1985 NAMCO LTD.', 48, 200); drawText(g, 'ALL RIGHTS RESERVED', 48, 216);
  }
  private score(g: PixelSurface, presentation: Extract<ArenaPresentation, { kind: 'score' }>): void {
    const state = presentation.state;
    const timeline = scoreTimeline(state, presentation.elapsedMs);
    g.fillStyle(PALETTE.black); g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawText(g, 'HI-SCORE', 64, 24, PALETTE.red); drawText(g, String(presentation.highScore), 152, 24, PALETTE.yellow);
    const stage = `STAGE ${state.stage}`;
    drawText(g, stage, Math.floor((256 - stage.length * 8) / 2), 40);
    state.players.forEach((player, index) => {
      const right = index === 1, color = right ? PALETTE.green : PALETTE.red;
      drawText(g, right ? 'II-PLAYER' : 'I-PLAYER', right ? 160 : 24, 56, color);
      const totalScore = String(player.score);
      drawText(g, totalScore, right ? 232 - totalScore.length * 8 : 88 - totalScore.length * 8, 72, PALETTE.yellow);
      ENEMY_KINDS.forEach((_kind, row) => {
        const y = 104 + row * 24;
        const value = timeline.rows[row].points[index];
        const points = String(value ?? 0);
        // Labels are already present before each row's numbers are revealed.
        drawText(g, 'PTS', right ? 200 : 64, y);
        if (value === null) return;
        drawText(g, points, right ? 160 : 56 - points.length * 8, y);
        const count = String(timeline.rows[row].counts[index]);
        drawText(g, count, right ? 144 : 112 - count.length * 8, y);
      });
      drawText(g, 'TOTAL', right ? 160 : 48, 192);
      if (timeline.totalVisible) {
        drawText(g, String(timeline.totals[index]), right ? 144 : 104, 192);
      }
    });
    SCORE_ENEMIES.forEach((sprite, row) => {
      const y = 100 + row * 24;
      drawBitmap(g, sprite, 120, y, { W: PALETTE.white, S: PALETTE.light, C: PALETTE.cyan });
      drawBitmap(g, ['....1...', '...11...', '..111111', '.1111111', '..111111', '...11...', '....1...', '........'], 112, y + 4, { '1': PALETTE.white });
    });
    g.fillStyle(PALETTE.white); g.fillRect(96, 189, 64, 2);
  }
}
