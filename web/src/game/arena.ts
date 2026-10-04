import Phaser from 'phaser';
import { ARENA_SIZE, BASE_X, BASE_Y, GRID_SIZE, TILE_SIZE } from '../core/constants';
import { Tile, type GameState, type Tank } from '../core/types';

export const CANVAS_WIDTH = 256;
export const CANVAS_HEIGHT = 240;
const ARENA_OFFSET = { x: 8, y: 16 };

export class ArenaScene extends Phaser.Scene {
  state: GameState | null = null;
  draft: Tile[] | null = null;
  onFrame: (delta: number) => void = () => {};
  onPaint: (x: number, y: number) => void = () => {};
  private graphics!: Phaser.GameObjects.Graphics;
  private label!: Phaser.GameObjects.Text;
  private pointsLabels: Phaser.GameObjects.Text[] = [];
  constructor() { super('arena'); }
  create(): void {
    this.graphics = this.add.graphics();
    this.label = this.add.text(225, 154, '', { fontFamily: 'monospace', fontSize: '8px', color: '#182015', lineSpacing: 5 });
    this.pointsLabels = Array.from({ length: 8 }, () => this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: '8px', color: '#fff0b0',
      stroke: '#101712', strokeThickness: 1,
    }).setOrigin(0.5).setVisible(false));
    this.input.on('pointerdown', this.paint, this);
    this.input.on('pointermove', this.paint, this);
  }
  update(_time: number, delta: number): void {
    this.onFrame(delta);
    if (!this.graphics) return;
    const g = this.graphics;
    const state = this.state;
    const tick = state?.tick ?? Math.floor(_time / 90);
    g.clear();
    g.fillStyle(0xa5a894).fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    g.fillStyle(0x101712).fillRect(ARENA_OFFSET.x, ARENA_OFFSET.y, ARENA_SIZE, ARENA_SIZE);
    const tiles = this.draft ?? state?.tiles;
    if (tiles) {
      tiles.forEach((tile, index) => { if (tile !== Tile.Forest) this.tile(tile, index, state?.brickMasks[index] ?? 15, tick); });
    } else {
      for (let index = 0; index < GRID_SIZE * GRID_SIZE; index++) {
        const x = index % GRID_SIZE, y = Math.floor(index / GRID_SIZE);
        if ((x < 4 || x > 21) && y % 5 < 3) this.tile(Tile.Brick, index, 15, tick);
        if ((y === 3 || y === 22) && x % 4 < 2) this.tile(Tile.Steel, index, 15, tick);
      }
    }
    if (state) {
      state.tanks.forEach(tank => this.tank(tank, tick));
      g.fillStyle(0xfff8d4);
      state.bullets.forEach(bullet => {
        if (!bullet.impactTicks) g.fillRect(ARENA_OFFSET.x + Math.round(bullet.x) - 2, ARENA_OFFSET.y + Math.round(bullet.y) - 2, 4, 4);
      });
      if (state.powerUp && tick % 32 < 24) this.powerUp(state.powerUp.x, state.powerUp.y, state.powerUp.kind);
      state.effects.forEach(effect => {
        if (effect.kind === 'explosion') {
          const radius = 4 + (24 - Math.min(24, effect.remainingTicks)) / 2;
          const x = effect.x + ARENA_OFFSET.x, y = effect.y + ARENA_OFFSET.y;
          g.fillStyle(0xcc5a3b).fillRect(x - radius, y - radius / 2, radius * 2, radius);
          g.fillStyle(0xefc45b).fillRect(x - radius / 2, y - radius, radius, radius * 2);
          g.fillStyle(0xfff0b0).fillRect(x - 3, y - 3, 6, 6);
        }
      });
    }
    this.base(state?.baseAlive ?? true);
    if (tiles) tiles.forEach((tile, index) => { if (tile === Tile.Forest) this.tile(tile, index, 15, tick); });
    this.pointsLabels.forEach(label => label.setVisible(false));
    state?.effects.filter(effect => effect.kind === 'points').slice(0, this.pointsLabels.length).forEach((effect, index) => {
      this.pointsLabels[index]
        .setText(String(effect.value ?? 0))
        .setPosition(ARENA_OFFSET.x + Math.round(effect.x), ARENA_OFFSET.y + Math.round(effect.y))
        .setVisible(true);
    });
    if (this.draft) {
      g.fillStyle(0x354131);
      for (let i = 0; i <= 13; i++) {
        g.fillRect(ARENA_OFFSET.x + Math.min(i * 16, ARENA_SIZE - 1), ARENA_OFFSET.y, 1, ARENA_SIZE);
        g.fillRect(ARENA_OFFSET.x, ARENA_OFFSET.y + Math.min(i * 16, ARENA_SIZE - 1), ARENA_SIZE, 1);
      }
      g.fillStyle(0x8a7b4d);
      for (const [x, y] of [[0, 0], [96, 0], [192, 0], [64, 192], [128, 192]]) {
        const sx = ARENA_OFFSET.x + x + 2, sy = ARENA_OFFSET.y + y + 2;
        g.fillRect(sx, sy, 12, 1).fillRect(sx, sy + 11, 12, 1).fillRect(sx, sy, 1, 12).fillRect(sx + 11, sy, 1, 12);
      }
    }
    const remaining = state ? Math.max(0, state.enemyQueue.length - state.spawned) : 20;
    for (let i = 0; i < remaining; i++) {
      const x = 227 + i % 2 * 11, y = 20 + Math.floor(i / 2) * 10;
      g.fillStyle(0x283224).fillRect(x, y, 2, 7).fillRect(x + 6, y, 2, 7).fillRect(x + 2, y + 1, 4, 5).fillRect(x + 3, y - 1, 2, 4);
    }
    const p1 = state?.players[0];
    const p2 = state?.players[1];
    this.label.setText(`I  ${p1?.lives ?? 2}\n${p2 ? `II ${p2.lives}` : ''}\n\n${this.draft ? 'EDIT' : 'STG'}\n${String(state?.stage ?? 1).padStart(2, '0')}`);
    if (state?.phase === 'intro') {
      g.fillStyle(0x101712, 0.92).fillRect(ARENA_OFFSET.x, ARENA_OFFSET.y, ARENA_SIZE, ARENA_SIZE);
      g.fillStyle(0xefc45b).fillRect(88, 109, 48, 3);
    }
  }
  private paint(pointer: Phaser.Input.Pointer): void {
    if (!this.draft || !pointer.leftButtonDown()) return;
    const x = Math.floor((pointer.x - ARENA_OFFSET.x) / TILE_SIZE);
    const y = Math.floor((pointer.y - ARENA_OFFSET.y) / TILE_SIZE);
    if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) this.onPaint(x, y);
  }
  private tile(tile: Tile, index: number, mask: number, tick: number): void {
    const x = ARENA_OFFSET.x + index % GRID_SIZE * TILE_SIZE;
    const y = ARENA_OFFSET.y + Math.floor(index / GRID_SIZE) * TILE_SIZE;
    const g = this.graphics;
    if (tile === Tile.Brick) {
      for (let q = 0; q < 4; q++) {
        if (!(mask & 1 << q)) continue;
        const qx = x + q % 2 * 4, qy = y + Math.floor(q / 2) * 4;
        g.fillStyle(0xab6745).fillRect(qx, qy, 4, 4);
        g.fillStyle(0xd09360).fillRect(qx, qy, 4, 1).fillRect(qx, qy + 2, 2, 1);
        g.fillStyle(0x663b2c).fillRect(qx + 3, qy + 1, 1, 3).fillRect(qx, qy + 3, 3, 1);
      }
    } else if (tile === Tile.Steel) {
      g.fillStyle(0x68766e).fillRect(x, y, 8, 8);
      g.fillStyle(0xc4cec0).fillRect(x, y, 7, 1).fillRect(x, y, 1, 7).fillRect(x + 2, y + 2, 4, 4);
      g.fillStyle(0x35443b).fillRect(x + 7, y, 1, 8).fillRect(x, y + 7, 8, 1);
    } else if (tile === Tile.Water) {
      g.fillStyle(0x285679).fillRect(x, y, 8, 8);
      const shift = Math.floor(tick / 16) % 2 * 2;
      g.fillStyle(0x7faeb0).fillRect(x + shift, y + 2, 4, 1).fillRect(x + 2 - shift, y + 6, 4, 1);
    } else if (tile === Tile.Forest) {
      g.fillStyle(0x245537).fillRect(x, y, 8, 8);
      g.fillStyle(0x467647).fillRect(x, y, 3, 3).fillRect(x + 4, y + 3, 4, 3);
      g.fillStyle(0x7e985a).fillRect(x + 2, y + 1, 3, 1).fillRect(x + 1, y + 5, 2, 2);
    } else if (tile === Tile.Ice) {
      g.fillStyle(0x9ebdb6).fillRect(x, y, 8, 8);
      g.fillStyle(0xd3e7d6).fillRect(x + 1, y + 2, 5, 1).fillRect(x + 4, y + 5, 4, 1);
    }
  }
  private tank(tank: Tank, tick: number): void {
    const g = this.graphics;
    const x = ARENA_OFFSET.x + Math.round(tank.x), y = ARENA_OFFSET.y + Math.round(tank.y);
    if (tank.spawnTicks > 0) {
      const radius = 3 + Math.floor(tick / 4) % 4;
      g.fillStyle(0xf0d976).fillRect(x + 7, y + 8 - radius, 2, radius * 2).fillRect(x + 8 - radius, y + 7, radius * 2, 2);
      return;
    }
    let color = tank.team === 'player' ? (tank.playerIndex === 0 ? 0xefc45b : 0xa7bfe0) : ({ basic: 0xc8cbb9, fast: 0xd76d48, power: 0x93b9bd, armor: tank.hp > 2 ? 0x78965d : 0xc4b277 })[tank.kind];
    if (tank.carryingPowerUp && tick % 20 < 10) color = 0xe87b64;
    const rotation = ['up', 'right', 'down', 'left'].indexOf(tank.direction);
    const rect = (rx: number, ry: number, w: number, h: number, c: number): void => {
      let ox = rx, oy = ry, rw = w, rh = h;
      if (rotation === 1) { ox = 16 - ry - h; oy = rx; rw = h; rh = w; }
      if (rotation === 2) { ox = 16 - rx - w; oy = 16 - ry - h; }
      if (rotation === 3) { ox = ry; oy = 16 - rx - w; rw = h; rh = w; }
      g.fillStyle(c).fillRect(x + ox, y + oy, rw, rh);
    };
    rect(1, 3, 3, 12, 0x4b5041); rect(12, 3, 3, 12, 0x4b5041);
    const offset = tank.moving ? Math.floor(tick / 4) % 2 : 0;
    for (let i = offset; i < 11; i += 3) { rect(1, 4 + i, 3, 1, color); rect(12, 4 + i, 3, 1, color); }
    rect(4, 4, 8, 10, color); rect(5, 5, 6, 1, 0xf4e5b7);
    rect(6, 6, 5, 6, 0x716645); rect(6, 6, 4, 4, color);
    rect(7, 0, 2, 8, color); rect(8, 1, 1, 5, 0xf4e5b7);
    if (tank.stars) rect(5, 12, Math.min(6, tank.stars * 2), 1, 0xfff1b4);
    if (tank.shieldTicks > 0 && tick % 12 < 7) {
      g.lineStyle(1, 0xeaeab9).strokeRect(x - 1, y - 1, 18, 18);
      g.lineStyle(1, 0x98bdce).strokeRect(x - 3, y - 3, 22, 22);
    }
  }
  private base(alive: boolean): void {
    const g = this.graphics;
    const x = ARENA_OFFSET.x + BASE_X, y = ARENA_OFFSET.y + BASE_Y;
    g.fillStyle(0x101712).fillRect(x, y, 16, 16);
    g.fillStyle(alive ? 0xd8cc9b : 0x726752);
    g.fillRect(x + 6, y + 4, 4, 9).fillRect(x + 7, y + 1, 4, 4);
    for (let i = 0; i < 3; i++) g.fillRect(x + i, y + 3 + i * 2, 5 - i, 2).fillRect(x + 11 + i, y + 3 + i * 2, 5 - i, 2);
    g.fillRect(x + 4, y + 12, 8, 2);
    if (!alive) g.fillStyle(0x101712).fillRect(x + 4, y + 5, 8, 3).fillRect(x + 6, y, 3, 12);
  }
  private powerUp(px: number, py: number, kind: string): void {
    const g = this.graphics;
    const x = ARENA_OFFSET.x + px, y = ARENA_OFFSET.y + py;
    g.fillStyle(0xe7d6a0).fillRect(x, y, 16, 16);
    g.fillStyle(0x303b2e).fillRect(x + 1, y + 1, 14, 14);
    g.fillStyle(0xe7d6a0);
    if (kind === 'star') { g.fillRect(x + 7, y + 3, 2, 10).fillRect(x + 3, y + 6, 10, 3).fillRect(x + 5, y + 5, 6, 6); }
    else if (kind === 'helmet') { g.fillRect(x + 4, y + 4, 8, 6).fillRect(x + 2, y + 10, 12, 2); }
    else if (kind === 'timer') { g.lineStyle(1, 0xe7d6a0).strokeCircle(x + 8, y + 8, 5); g.fillRect(x + 8, y + 4, 1, 5).fillRect(x + 8, y + 8, 4, 1); }
    else if (kind === 'shovel') { g.fillRect(x + 6, y + 3, 5, 5).fillRect(x + 8, y + 8, 1, 6); }
    else if (kind === 'grenade') { g.fillRect(x + 5, y + 5, 6, 8).fillRect(x + 6, y + 2, 4, 2); }
    else { g.fillRect(x + 3, y + 6, 10, 7).fillRect(x + 7, y + 2, 2, 6); }
  }
}
