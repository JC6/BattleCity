import { describe, expect, it } from 'vitest';
import { advanceBullets, enemyFire, fireBullet, resolveBulletHits, updateBullets } from '../../src/core/combat';
import type { CoreContext } from '../../src/core/context';
import { GameEngine } from '../../src/core/engine';
import { EMPTY_INPUT, Tile, type Bullet, type GunSlot, type Tank } from '../../src/core/types';

function fixture() {
  const engine = new GameEngine({ tiles: Array(26 * 26).fill(Tile.Empty), enemies: Array(20).fill('basic') },
    { mode: 'coop', stage: 1, seed: 123 });
  const state = engine.state;
  Object.assign(state, { phase: 'playing', introTicks: 0, spawnTimer: 100_000, freezeTicks: 10_000 });
  for (const tank of state.tanks) Object.assign(tank, { spawnTicks: 0, shieldTicks: 0 });
  let id = 10_000;
  const context: CoreContext = { state, events: [], nextId: () => ++id };
  const addShot = (gunSlot: GunSlot, values: Partial<Bullet> = {}) => {
    const player = gunSlot < 2 || gunSlot >= 8;
    const bullet: Bullet = { id: ++id, gunSlot, team: player ? 'player' : 'enemy',
      playerIndex: player ? (gunSlot & 1) as 0 | 1 : null,
      x: 68, y: 62, direction: 'down', speed: 2, steelPower: false, ...values };
    state.bullets.push(bullet);
    return bullet;
  };
  const addEnemy = (x: number, y: number, enemySlot = 0): Tank => {
    const tank: Tank = { ...state.tanks[0]!, id: ++id, team: 'enemy', playerIndex: null, enemySlot,
      kind: 'basic', x, y, direction: 'up', hp: 1, stars: 0 };
    state.tanks.push(tank);
    return tank;
  };
  return { engine, state, context, addShot, addEnemy };
}

describe('original physical gun slots and combat phases', () => {
  it.each([0, 1] as const)('moves player %i primary into its secondary before firing another primary', index => {
    const { state, context } = fixture();
    const tank = state.tanks[index]!;
    tank.stars = 2;
    fireBullet(context, tank);
    const original = state.bullets[0]!;
    const snapshot = { ...original };
    Object.assign(tank, { x: 40, y: 40, direction: 'right' });
    fireBullet(context, tank);
    expect(original).toEqual({ ...snapshot, gunSlot: index + 8 });
    expect(state.bullets[1]).toMatchObject({ gunSlot: index, x: 56, y: 48, direction: 'right', speed: 4 });
    fireBullet(context, tank);
    expect(state.bullets).toHaveLength(2);
  });

  it('migrates an occupied impact and allows a downgraded player to reuse a free primary', () => {
    const { state, context, addShot } = fixture();
    const tank = state.tanks[0]!;
    tank.stars = 3;
    const impact = addShot(0, { x: 40, y: 40, speed: 4, steelPower: true, impactTicks: 6 });
    fireBullet(context, tank);
    expect(impact).toMatchObject({ gunSlot: 8, x: 40, y: 40, steelPower: true, impactTicks: 6 });
    state.bullets.find(bullet => bullet.gunSlot === 0)!.impactTicks = 1;
    tank.stars = state.players[0]!.stars = 0;
    advanceBullets(context);
    fireBullet(context, tank);
    expect(state.bullets).toHaveLength(2);
    expect(impact).toMatchObject({ gunSlot: 8, impactTicks: 5, steelPower: true });
    expect(state.bullets.find(bullet => bullet.gunSlot === 0)).toMatchObject({ speed: 2, steelPower: false });
  });

  it('keeps both player guns and their shot upgrades when the firing tank is killed', () => {
    const { engine, state, context, addShot } = fixture();
    const tank = state.tanks[0]!;
    tank.stars = state.players[0]!.stars = 3;
    fireBullet(context, tank); fireBullet(context, tank);
    const owned = [...state.bullets];
    addShot(2, { x: tank.x + 8, y: tank.y + 6 });
    engine.step([]);
    expect(state.tanks).not.toContain(tank);
    expect(state.players[0]).toMatchObject({ stars: 0, respawnTicks: 48 });
    expect(state.bullets).toEqual(expect.arrayContaining(owned));
    expect(owned.map(bullet => bullet.gunSlot).sort()).toEqual([0, 8]);
    expect(owned.every(bullet => bullet.speed === 4 && bullet.steelPower)).toBe(true);
  });

  it('fires at the barrel after old-shot movement, and releases an expired primary before firing', () => {
    const { engine, state, addShot } = fixture();
    const tank = state.tanks[0]!;
    Object.assign(tank, { x: 64, y: 80, direction: 'up' });
    const oldSecondary = addShot(8, { x: 40, y: 40, speed: 4, direction: 'right' });
    addShot(0, { impactTicks: 1 });
    engine.step([{ ...EMPTY_INPUT, firePressed: true }]);
    expect(oldSecondary.x).toBe(44);
    const fresh = state.bullets.find(bullet => bullet.gunSlot === 0)!;
    expect(fresh).toMatchObject({ x: 72, y: 80, speed: 2 });
    engine.step([]);
    expect(fresh.y).toBe(78);
  });

  it('does not consume a firing random draw for an enemy that is still being born', () => {
    const { state, context, addEnemy } = fixture();
    state.freezeTicks = 0;
    const tank = addEnemy(32, 32);
    tank.spawnTicks = 1;
    const rng = state.rng;
    enemyFire(context, tank);
    expect(state.rng).toBe(rng);
    expect(state.bullets).toHaveLength(0);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const)('moves ordinary slot %i every frame while terrain checks use slot parity', gunSlot => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    const index = 8 * 26 + 8;
    state.tiles[index] = Tile.Steel;
    const bullet = addShot(gunSlot);
    state.tick = 0;
    updateBullets(context);
    expect(bullet.y).toBe(64);
    expect(bullet.impactTicks).toBe((gunSlot & 1) ? 9 : undefined);
    if (!(gunSlot & 1)) {
      state.tick++;
      updateBullets(context);
      expect(bullet.y).toBe(66);
      expect(bullet.impactTicks).toBe(9);
    }
  });

  it.each([0, 1] as const)('moves fast shots four pixels and checks terrain on frame parity %i', tick => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = tick;
    state.tiles[8 * 26 + 8] = Tile.Steel;
    const bullet = addShot(0, { speed: 4 });
    updateBullets(context);
    expect(bullet).toMatchObject({ y: 66, impactTicks: 9 });
  });

  it('clears both four-pixel brick columns within the selected cell without extending into its neighbor', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const index = 8 * 26 + 8;
    for (const cell of [index, index + 1]) {
      state.tiles[cell] = Tile.Brick;
      state.brickMasks[cell] = 15;
    }
    addShot(0); // Final x=68; +4 changes the quadrant but keeps the x=64 cell pointer.
    updateBullets(context);
    expect(state.brickMasks[index]).toBe(12);
    expect(state.brickMasks[index + 1]).toBe(15);
  });

  it('checks both barrel edges in separate cells and removes only their contacted four-pixel layer', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const index = 8 * 26 + 8;
    for (const cell of [index - 1, index]) {
      state.tiles[cell] = Tile.Brick;
      state.brickMasks[cell] = 15;
    }
    addShot(0, { x: 64 });
    updateBullets(context);
    expect(state.brickMasks.slice(index - 1, index + 1)).toEqual([12, 12]);
  });

  it.each([
    ['down', 68, 62, 12], ['up', 68, 72, 3], ['right', 62, 68, 10], ['left', 72, 68, 5],
  ] as const)('chips the contacted layer for a %s shot', (direction, x, y, remaining) => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const index = 8 * 26 + 8;
    state.tiles[index] = Tile.Brick;
    state.brickMasks[index] = 15;
    addShot(0, { x, y, direction });
    updateBullets(context);
    expect(state.brickMasks[index]).toBe(remaining);
  });

  it('does not run the extra brick quadrant probe unless its first quadrant contains brick', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const index = 8 * 26 + 8;
    state.tiles[index] = Tile.Brick;
    state.brickMasks[index] = 2; // Only top right survives; both first probes fall in top left.
    const bullet = addShot(0, { x: 67 });
    updateBullets(context);
    expect(state.brickMasks[index]).toBe(2);
    expect(bullet.impactTicks).toBeUndefined();
  });

  it('preserves each contacted material and the physical slot for the frame sound requests', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const index = 8 * 26 + 8;
    state.tiles[index] = Tile.Steel;
    state.tiles[index - 1] = Tile.Brick;
    state.brickMasks[index - 1] = 15;
    addShot(0, { x: 64 });
    updateBullets(context);
    expect(context.events).toEqual([
      { type: 'hit', target: 'steel', team: 'player', playerIndex: 0, gunSlot: 0, steelPower: false },
      { type: 'hit', target: 'brick', team: 'player', playerIndex: 0, gunSlot: 0, steelPower: false },
    ]);
  });

  it('requires an actual base-cell probe rather than the bullet sprite rectangle touching the eagle', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    state.tick = 1;
    const bullet = addShot(0, { x: 104, y: 189 });
    updateBullets(context);
    expect(bullet.y).toBe(191);
    expect(state.baseAlive).toBe(true);
    expect(bullet.impactTicks).toBeUndefined();
    state.tick = 3;
    updateBullets(context);
    expect(state.baseAlive).toBe(false);
    expect(bullet.impactTicks).toBe(9);
  });

  it('tests tanks even on an ordinary shot frame that skips terrain', () => {
    const { state, context, addShot, addEnemy } = fixture();
    state.tick = 0;
    const target = addEnemy(64, 64);
    addShot(0, { y: 62 });
    updateBullets(context);
    expect(state.tanks).not.toContain(target);
    expect(state.players[0]!.kills).toEqual([1, 0, 0, 0]);
  });

  it('cancels opposing guns before tank hits and keeps enemy guns from cancelling each other', () => {
    const { state, context, addShot, addEnemy } = fixture();
    const target = addEnemy(76, 72);
    addShot(0, { x: 80, y: 80, direction: 'right', speed: 4 });
    addShot(2, { x: 88, y: 80, direction: 'left', speed: 4 });
    updateBullets(context);
    expect(state.bullets).toHaveLength(0);
    expect(state.tanks).toContain(target);
    expect(state.killed).toBe(0);
    state.tanks = [];
    addShot(2, { x: 80, y: 80, direction: 'right', speed: 4 });
    addShot(3, { x: 88, y: 80, direction: 'left', speed: 4 });
    updateBullets(context);
    expect(state.bullets).toHaveLength(2);
  });

  it('credits simultaneous enemy hits in physical player-gun order instead of array or ID order', () => {
    const { state, context, addShot, addEnemy } = fixture();
    addEnemy(80, 80);
    const first = addShot(8, { x: 80, y: 80 });
    const second = addShot(9, { x: 96, y: 80 });
    first.id = 999_999;
    second.id = 1;
    resolveBulletHits(context);
    expect(state.players.map(player => player.score)).toEqual([0, 100]);
    expect(second.impactTicks).toBe(9);
    expect(first.impactTicks).toBeUndefined();
  });

  it('finishes the current opposing-shot scan even after its player gun is cleared', () => {
    const { state, context, addShot } = fixture();
    state.tanks = [];
    addShot(0, { x: 80, y: 80 });
    addShot(2, { x: 83, y: 80 });
    addShot(3, { x: 77, y: 80 });
    resolveBulletHits(context);
    expect(state.bullets).toHaveLength(0); // E960 clears both slots, then E969 continues the inner loop.
  });
});
