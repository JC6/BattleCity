import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import type { CoreContext } from '../../src/core/context';
import { destroyEnemy, fireBullet, updateBullets } from '../../src/core/combat';
import { EMPTY_INPUT, Tile, type Bullet, type EnemyKind, type GameMode,
  type LevelDefinition, type PlayerInput, type Tank } from '../../src/core/types';
import { getLevel } from '../../src/data/levels';
import { FORTRESS_CELLS, spawnInterval } from '../../src/core/rules';
import { chooseEnemyDirection } from '../../src/core/ai';
import { moveTank } from '../../src/core/movement';
import { updateSpawning } from '../../src/core/spawning';

const level = (enemies: EnemyKind[] = Array(20).fill('basic')): LevelDefinition => ({
  tiles: Array(26 * 26).fill(Tile.Empty), enemies,
});
const input = (values: Partial<PlayerInput> = {}): PlayerInput => ({ ...EMPTY_INPUT, ...values });

function game(mode: GameMode = 'single'): GameEngine {
  const engine = new GameEngine(level(), { mode, stage: 1, seed: 123 });
  engine.state.phase = 'playing';
  engine.state.introTicks = 0;
  engine.state.spawnTimer = 100_000;
  for (const tank of engine.state.tanks) {
    tank.spawnTicks = 0;
    tank.shieldTicks = 0;
  }
  return engine;
}

function advance(engine: GameEngine, ticks: number, inputs: readonly PlayerInput[] = [EMPTY_INPUT]): void {
  for (let tick = 0; tick < ticks; tick++) engine.step(inputs);
}

function enemy(engine: GameEngine, kind: EnemyKind = 'basic', x = 96, y = 80): Tank {
  const tank: Tank = {
    ...engine.state.tanks[0]!, id: 100 + engine.state.tanks.length,
    team: 'enemy', playerIndex: null,
    enemySlot: engine.state.tanks.filter(candidate => candidate.team === 'enemy').length,
    kind, x, y, direction: 'down',
    hp: kind === 'armor' ? 4 : 1, stars: 0,
    spawnTicks: 0, shieldTicks: 0, stunTicks: 0, carryingPowerUp: false,
  };
  engine.state.tanks.push(tank);
  engine.state.freezeTicks = 10_000;
  return tank;
}

let shotId = 10_000;
function shot(engine: GameEngine, x: number, y: number, values: Partial<Bullet> = {}): void {
  engine.state.bullets.push({
    id: shotId++,
    team: 'player', playerIndex: 0, enemySlot: null, x, y,
    direction: 'down', speed: 2, steelPower: false, ...values,
  });
}

function enemyShot(engine: GameEngine, target: Tank): void {
  shot(engine, target.x + 8, target.y - 2, { team: 'enemy', playerIndex: null, enemySlot: 0 });
}

describe('fixed simulation, input and transitions', () => {
  it('owns the intro countdown, preserves it across pause and emits one stage-start', () => {
    const engine = new GameEngine(level(), { mode: 'single', stage: 1 });
    advance(engine, 30);
    engine.setPaused(true);
    const snapshot = structuredClone(engine.state);
    advance(engine, 300, [input({ firePressed: true, up: true })]);
    expect(engine.state).toEqual(snapshot);
    engine.setPaused(false);
    advance(engine, 89);
    expect(engine.state.phase).toBe('intro');
    expect(engine.step([])).toEqual([{ type: 'stage-start' }]);
    expect(engine.state.phase).toBe('playing');
    expect(engine.step([]).filter(event => event.type === 'stage-start')).toHaveLength(0);
  });

  it('moves a player exactly 3 pixels in four NTSC logic frames', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    const y = player.y;
    advance(engine, 4, [input({ up: true })]);
    expect(player.y).toBe(y - 3);
    expect(player.x).toBe(64);
  });

  it('uses NES direction-bit priority and rounds a perpendicular turn to the 8px grid', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    player.x = 67;
    player.y = 169;
    engine.step([input({ up: true, left: true, right: true, down: true })]);
    expect(player.direction).toBe('right');
    expect(player.x).toBe(65);
    expect(player.y).toBe(168);
  });

  it('shoots only for a press edge and does not repeat on later ticks', () => {
    const engine = game();
    advance(engine, 12);
    expect(engine.state.bullets).toHaveLength(0);
    engine.step([input({ firePressed: true })]);
    expect(engine.state.bullets).toHaveLength(1);
    advance(engine, 10);
    expect(engine.state.bullets).toHaveLength(1);
  });

  it('produces identical states and events for a seeded input replay', () => {
    const original = getLevel(4);
    const first = new GameEngine(original, { mode: 'coop', stage: 4, seed: 7654321 });
    const second = new GameEngine(original, { mode: 'coop', stage: 4, seed: 7654321 });
    for (let tick = 0; tick < 1200; tick++) {
      const commands = [input({ up: tick % 120 < 60, firePressed: tick % 37 === 0 }),
        input({ left: tick % 180 < 70, firePressed: tick % 29 === 0 })];
      expect(first.step(commands)).toEqual(second.step(commands));
    }
    expect(first.state).toEqual(second.state);
  });

  it('keeps moving an existing enemy shot while the clock freezes enemy tanks', () => {
    const engine = game();
    const tank = enemy(engine, 'fast', 32, 32);
    shot(engine, 40, 55, { team: 'enemy', playerIndex: null, enemySlot: tank.enemySlot });
    advance(engine, 4);
    expect(tank.y).toBe(32);
    expect(engine.state.bullets[0]!.y).toBe(63);
  });

  it('can convert a pending clear to game-over when a remaining shot destroys the base', () => {
    const engine = game();
    engine.state.spawned = engine.state.enemyQueue.length;
    engine.state.killed = engine.state.enemyQueue.length;
    engine.step([]);
    expect(engine.state.phase).toBe('playing');
    expect(engine.state.pendingOutcome).toBe('won');
    expect(engine.state.outroTicks).toBe(127);
    shot(engine, 104, 189, { team: 'enemy', playerIndex: null, enemySlot: 0 });
    engine.step([]);
    expect(engine.state.pendingOutcome).toBe('lost');
    expect(engine.state.outroTicks).toBe(126);
    advance(engine, 126);
    expect(engine.state.baseAlive).toBe(false);
    expect(engine.state.phase).toBe('lost');
  });

  it('stops all tracks on the exact tick the base is destroyed and keeps the tanks still', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    const tank = enemy(engine, 'basic', 32, 64);
    engine.state.freezeTicks = 0;
    shot(engine, 104, 189, { team: 'enemy', playerIndex: null, enemySlot: 0 });
    engine.step([input({ up: true })]);
    // Both tanks completed their movement before the fatal shot was resolved.
    expect([player.y, tank.y]).toEqual([191, 65]);
    expect(engine.state.pendingOutcome).toBe('lost');
    expect(engine.state.tanks.every(candidate => !candidate.moving)).toBe(true);
    advance(engine, 10, [input({ up: true })]);
    expect([player.y, tank.y]).toEqual([191, 65]);
    expect(engine.state.tanks.every(candidate => !candidate.moving)).toBe(true);
  });

  it('clears motion when a player skips a frame or releases input and an enemy freezes or spawns', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    const tank = enemy(engine, 'fast', 32, 32);
    engine.state.freezeTicks = 0;
    engine.step([input({ up: true })]);
    expect([player.moving, tank.moving]).toEqual([true, true]);
    engine.state.freezeTicks = 100;
    engine.step([input({ up: true })]);
    expect([player.moving, tank.moving]).toEqual([false, false]);
    engine.state.freezeTicks = 0;
    engine.step([]);
    expect([player.moving, tank.moving]).toEqual([false, true]);
    tank.spawnTicks = 2;
    engine.step([]);
    expect(tank.spawnTicks).toBeGreaterThan(0);
    expect(tank.moving).toBe(false);
  });
});

describe('collision, projectiles and terrain', () => {
  it.each([Tile.Brick, Tile.Steel, Tile.Water])('blocks a moving tank at solid terrain %s', tile => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    player.x = 64;
    player.y = 48;
    engine.state.tiles[5 * 26 + 8] = tile;
    engine.state.tiles[5 * 26 + 9] = tile;
    engine.state.brickMasks[5 * 26 + 8] = 15;
    engine.state.brickMasks[5 * 26 + 9] = 15;
    advance(engine, 8, [input({ up: true })]);
    expect(player.y).toBe(48);
  });

  it('allows forest movement and continues sliding briefly after releasing on ice', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    player.x = 64;
    player.y = 80;
    for (let row = 0; row < 20; row++) {
      engine.state.tiles[row * 26 + 8] = Tile.Ice;
      engine.state.tiles[row * 26 + 9] = Tile.Ice;
    }
    advance(engine, 4, [input({ up: true })]);
    const releasedY = player.y;
    advance(engine, 4);
    expect(player.y).toBeLessThan(releasedY);
    advance(engine, 50);
    const stoppedY = player.y;
    advance(engine, 8);
    expect(player.y).toBe(stoppedY);
    player.x = 32;
    player.y = 80;
    engine.state.tiles[9 * 26 + 4] = Tile.Forest;
    advance(engine, 4, [input({ up: true })]);
    expect(player.y).toBe(77);
  });

  it('chips the near 4px brick layer, then the far layer, without mutating level data', () => {
    const definition = level();
    const index = 8 * 26 + 8;
    definition.tiles[index] = Tile.Brick;
    const engine = new GameEngine(definition, { mode: 'single', stage: 1 });
    engine.state.phase = 'playing';
    engine.state.spawnTimer = 100_000;
    shot(engine, 68, 62);
    engine.step([]);
    expect(engine.state.brickMasks[index]).toBe(12);
    expect(engine.state.tiles[index]).toBe(Tile.Brick);
    shot(engine, 68, 65);
    engine.step([]);
    expect(engine.state.tiles[index]).toBe(Tile.Empty);
    expect(definition.tiles[index]).toBe(Tile.Brick);
  });

  it('requires armor-piercing player shots to remove steel; water passes shots', () => {
    const engine = game();
    const index = 8 * 26 + 8;
    engine.state.tiles[index] = Tile.Steel;
    shot(engine, 68, 62);
    engine.step([]);
    expect(engine.state.tiles[index]).toBe(Tile.Steel);
    shot(engine, 68, 62, { steelPower: true });
    engine.step([]);
    expect(engine.state.tiles[index]).toBe(Tile.Empty);
    engine.state.tiles[index] = Tile.Water;
    shot(engine, 68, 64);
    engine.step([]);
    expect(engine.state.bullets.at(-1)!.impactTicks).toBeUndefined();
    expect(engine.state.bullets.at(-1)!.y).toBe(66);
  });

  it('limits two-star tanks to two fast bullets and one-star tanks to one', () => {
    const engine = game();
    const tank = engine.state.tanks[0]!;
    tank.stars = 2;
    advance(engine, 3, [input({ firePressed: true })]);
    expect(engine.state.bullets).toHaveLength(2);
    expect(engine.state.bullets.every(bullet => bullet.speed === 4)).toBe(true);
    engine.state.bullets = [];
    tank.stars = 1;
    advance(engine, 3, [input({ firePressed: true })]);
    expect(engine.state.bullets).toHaveLength(1);
  });

  it('cancels crossing player/enemy shots immediately', () => {
    const engine = game();
    shot(engine, 80, 80, { direction: 'right', speed: 4 });
    shot(engine, 88, 80, { direction: 'left', speed: 4, team: 'enemy', playerIndex: null, enemySlot: 0 });
    engine.step([]);
    expect(engine.state.bullets).toHaveLength(0);
  });

  it('preserves crossing shots for the same player when its tank identity changes', () => {
    const engine = game('coop');
    const state = engine.state;
    const context: CoreContext = { state, events: [], nextId: () => shotId++ };
    const original = state.tanks[0]!;
    Object.assign(original, { x: 64, y: 80, direction: 'right', stars: 2 });
    state.players[0]!.stars = 2;
    fireBullet(context, original);
    // Replace only the shooter fixture; this does not model a classic death.
    const replacement: Tank = { ...original, id: original.id + 1_000, x: 88, direction: 'left' };
    state.tanks[0] = replacement;
    fireBullet(context, replacement);
    expect(replacement.id).not.toBe(original.id);
    expect(state.bullets.map(bullet => bullet.playerIndex)).toEqual([0, 0]);
    updateBullets(context);
    updateBullets(context);
    expect(state.bullets.map(bullet => bullet.x)).toEqual([88, 80]);
    expect(state.bullets.every(bullet => bullet.impactTicks === undefined)).toBe(true);
  });

  it('cancels crossing shots from different players immediately', () => {
    const engine = game('coop');
    const context: CoreContext = { state: engine.state, events: [], nextId: () => shotId++ };
    const [first, second] = engine.state.tanks;
    Object.assign(first!, { x: 64, y: 80, direction: 'right' });
    Object.assign(second!, { x: 88, y: 80, direction: 'left' });
    fireBullet(context, first!);
    fireBullet(context, second!);
    expect(engine.state.bullets.map(bullet => bullet.playerIndex)).toEqual([0, 1]);
    updateBullets(context);
    expect(engine.state.bullets).toHaveLength(0);
  });

  it('keeps a wall-hit shot in its gun slot for nine frames, but a shield removes a shot immediately', () => {
    const engine = game();
    engine.state.tiles[8 * 26 + 8] = Tile.Steel;
    shot(engine, 68, 62);
    engine.step([]);
    expect(engine.state.bullets[0]!.impactTicks).toBe(9);
    advance(engine, 8);
    expect(engine.state.bullets).toHaveLength(1);
    engine.step([]);
    expect(engine.state.bullets).toHaveLength(0);
    const player = engine.state.tanks[0]!;
    player.shieldTicks = 100;
    enemyShot(engine, player);
    engine.step([]);
    expect(engine.state.bullets).toHaveLength(0);
    expect(engine.state.players[0]!.lives).toBe(2);
  });

  it.each(['player', 'enemy'] as const)('allows a %s projectile to destroy its own base', team => {
    const engine = game();
    shot(engine, 104, 189, { team, playerIndex: team === 'player' ? 0 : null, enemySlot: team === 'enemy' ? 0 : null });
    engine.step([]);
    expect(engine.state.baseAlive).toBe(false);
    expect(engine.state.effects).toEqual([{ kind: 'explosion', x: 104, y: 200, remainingTicks: 24 }]);
  });
});

describe('lives, scoring and power-ups', () => {
  it('takes four hits to kill armor and drops a carrier bonus on the first hit', () => {
    const engine = game();
    const tank = enemy(engine, 'armor');
    tank.carryingPowerUp = true;
    for (let hit = 1; hit <= 4; hit++) {
      shot(engine, tank.x + 8, tank.y - 2);
      engine.step([]);
      if (hit < 4) {
        expect(tank.hp).toBe(4 - hit);
        expect(engine.state.killed).toBe(0);
      }
      if (hit === 1) expect(engine.state.powerUp).not.toBeNull();
    }
    expect(engine.state.killed).toBe(1);
    expect(engine.state.players[0]!.score).toBe(400);
    expect(engine.state.players[0]!.kills).toEqual([0, 0, 0, 1]);
    expect(engine.state.effects).toEqual([
      { kind: 'explosion', x: 104, y: 88, remainingTicks: 24 },
      { kind: 'points', x: 104, y: 88, remainingTicks: 48, value: 400 },
    ]);
  });

  it('respawns with upgrades reset, then survives on the last active tank without spare lives', () => {
    const engine = game();
    let tank = engine.state.tanks[0]!;
    tank.stars = engine.state.players[0]!.stars = 3;
    enemyShot(engine, tank);
    engine.step([]);
    expect(engine.state.effects).toEqual([{ kind: 'explosion', x: 72, y: 200, remainingTicks: 24 }]);
    expect(engine.state.players[0]!.lives).toBe(1);
    expect(engine.state.players[0]!.stars).toBe(0);
    advance(engine, 48);
    tank = engine.state.tanks.find(candidate => candidate.team === 'player')!;
    expect(tank.stars).toBe(0);
    expect(tank.spawnTicks).toBeGreaterThan(0);
    advance(engine, 38);
    expect(tank.shieldTicks).toBeGreaterThan(150);
    engine.state.players[0]!.lives = 0;
    expect(engine.state.phase).toBe('playing');
    tank.shieldTicks = 0;
    enemyShot(engine, tank);
    engine.step([]);
    expect(engine.state.players[0]!.eliminated).toBe(true);
    advance(engine, 128);
    expect(engine.state.phase).toBe('lost');
  });

  it('stuns a partner without killing them and does not refresh an existing stun', () => {
    const engine = game('coop');
    const partner = engine.state.tanks[1]!;
    shot(engine, partner.x + 8, partner.y - 2);
    engine.step([]);
    expect(partner.stunTicks).toBe(200);
    expect(engine.state.players[1]!.lives).toBe(2);
    const y = partner.y;
    advance(engine, 4, [EMPTY_INPUT, input({ up: true })]);
    expect(partner.y).toBe(y);
    expect(partner.stunTicks).toBe(197);
    engine.step([EMPTY_INPUT, input({ firePressed: true })]);
    expect(engine.state.bullets.some(bullet => bullet.playerIndex === 1 && !bullet.impactTicks)).toBe(true);
  });

  it('grants a score life only at the first 20,000 points and retains that flag across stages', () => {
    const engine = game();
    const player = engine.state.players[0]!;
    player.score = 19_900;
    const tank = enemy(engine);
    shot(engine, tank.x + 8, tank.y - 2);
    const events = engine.step([]);
    expect(player.score).toBe(20_000);
    expect(player.lives).toBe(3);
    expect(player.nextExtraLife).toBe(Infinity);
    expect(events.some(event => event.type === 'extra-life')).toBe(true);
    player.score = 39_900;
    const second = enemy(engine, 'basic', 128, 80);
    shot(engine, second.x + 8, second.y - 2);
    engine.step([]);
    expect(player.lives).toBe(3);
    const next = new GameEngine(level(), { mode: 'single', stage: 2, players: [player] });
    expect(next.state.players[0]!.nextExtraLife).toBe(Infinity);
  });

  it('revives an eliminated cooperative player when its remaining shot earns the first score life', () => {
    const engine = game('coop');
    const state = engine.state;
    const original = state.tanks[0]!;
    Object.assign(original, { x: 64, y: 16, direction: 'right' });
    Object.assign(state.players[0]!, { lives: 0, score: 19_900 });
    enemy(engine, 'basic', 88, 16);
    state.freezeTicks = 8;
    enemyShot(engine, original);
    engine.step([input({ firePressed: true }), EMPTY_INPUT]);
    expect(state.players[0]!.eliminated).toBe(true);
    expect(state.pendingOutcome).toBeNull();
    advance(engine, 2);
    const events = engine.step([]);
    expect(events.filter(event => event.type === 'extra-life')).toHaveLength(1);
    expect(state.players[0]).toMatchObject({
      score: 20_000, lives: 0, stars: 0, eliminated: false,
      respawnTicks: 1, nextExtraLife: Infinity,
    });
    expect(state.pendingOutcome).toBeNull();
    engine.step([]);
    const replacement = state.tanks.find(tank => tank.playerIndex === 0)!;
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.spawnTicks).toBe(28);
    advance(engine, 38);
    expect(replacement.spawnTicks).toBe(0);
    expect(replacement.shieldTicks).toBeGreaterThan(0);
  });

  it('never resurrects an eliminated partner merely by carrying to the next stage', () => {
    const engine = game('coop');
    const partner = engine.state.players[1]!;
    partner.lives = 0;
    enemyShot(engine, engine.state.tanks[1]!);
    engine.step([]);
    const next = new GameEngine(level(), { mode: 'coop', stage: 2, players: engine.state.players });
    expect(next.state.tanks.filter(tank => tank.team === 'player').map(tank => tank.playerIndex)).toEqual([0]);
    expect(next.state.players[1]!.eliminated).toBe(true);
    expect(next.state.players[1]!.respawnTicks).toBe(0);
  });

  it('keeps a locked loss when a remaining shot crosses 20,000 points and clears the wave', () => {
    const engine = game();
    const player = engine.state.players[0]!;
    player.score = 19_900;
    player.lives = 0;
    engine.state.spawned = engine.state.enemyQueue.length;
    engine.state.killed = engine.state.enemyQueue.length - 1;
    const lastEnemy = enemy(engine);
    // This player shot reaches the enemy three ticks after the final death.
    shot(engine, lastEnemy.x + 8, lastEnemy.y - 8);
    enemyShot(engine, engine.state.tanks[0]!);
    engine.step([]);
    expect(engine.state.pendingOutcome).toBe('lost');
    expect(player.eliminated).toBe(true);
    const events = Array.from({ length: 3 }, () => engine.step([])).flat();
    expect(player.score).toBe(20_000);
    expect(engine.state.killed).toBe(engine.state.enemyQueue.length);
    expect(events.some(event => event.type === 'extra-life')).toBe(false);
    expect(player.lives).toBe(0);
    expect(player.eliminated).toBe(true);
    expect(player.respawnTicks).toBe(0);
    expect(player.nextExtraLife).toBe(20_000);
    expect(engine.state.pendingOutcome).toBe('lost');
    advance(engine, engine.state.outroTicks);
    expect(engine.state.phase).toBe('lost');
  });

  it('allows a winning cooperative bonus to earn the first score life for an eliminated partner', () => {
    const engine = game('coop');
    const partner = engine.state.players[1]!;
    partner.score = 19_000;
    partner.lives = 0;
    partner.kills = [1, 0, 0, 0];
    enemyShot(engine, engine.state.tanks[1]!);
    engine.step([]);
    expect(partner.eliminated).toBe(true);
    engine.state.spawned = engine.state.enemyQueue.length;
    engine.state.killed = engine.state.enemyQueue.length;
    let events = engine.step([]);
    expect(engine.state.pendingOutcome).toBe('won');
    for (let tick = 0; tick < 127; tick++) events = engine.step([]);
    expect(engine.state.phase).toBe('won');
    expect(events).toContainEqual({ type: 'extra-life' });
    expect(partner.score).toBe(20_000);
    expect(partner.nextExtraLife).toBe(Infinity);
    expect(partner.eliminated).toBe(false);
    expect(partner.lives).toBe(0);
    expect(partner.respawnTicks).toBe(1);
    const next = new GameEngine(level(), { mode: 'coop', stage: 2, players: engine.state.players });
    expect(next.state.tanks.filter(tank => tank.team === 'player').map(tank => tank.playerIndex)).toEqual([0, 1]);
    expect(next.state.players[1]!.lives).toBe(0);
  });

  it.each(['helmet', 'timer', 'shovel', 'star', 'tank'] as const)('collects %s with 500 points and its authentic effect', kind => {
    const engine = game();
    const tank = engine.state.tanks[0]!;
    engine.state.powerUp = { kind, x: tank.x, y: tank.y };
    engine.step([]);
    expect(engine.state.powerUp).toBeNull();
    expect(engine.state.players[0]!.score).toBe(500);
    if (kind === 'helmet') expect(tank.shieldTicks).toBe(639);
    if (kind === 'timer') expect(engine.state.freezeTicks).toBe(639);
    if (kind === 'shovel') {
      expect(engine.state.fortifyTicks).toBe(1279);
      expect(FORTRESS_CELLS.every(index => engine.state.tiles[index] === Tile.Steel)).toBe(true);
      advance(engine, 1280);
      expect(FORTRESS_CELLS.every(index => engine.state.tiles[index] === Tile.Brick)).toBe(true);
    }
    if (kind === 'star') expect(tank.stars).toBe(1);
    if (kind === 'tank') expect(engine.state.players[0]!.lives).toBe(3);
  });

  it('grenades destroy active armor without kill points or harming an enemy still spawning', () => {
    const engine = game();
    enemy(engine, 'armor');
    const spawning = enemy(engine, 'basic', 32, 16);
    spawning.spawnTicks = 28;
    const player = engine.state.tanks[0]!;
    engine.state.powerUp = { kind: 'grenade', x: player.x, y: player.y };
    engine.step([]);
    expect(engine.state.killed).toBe(1);
    expect(engine.state.tanks.some(tank => tank.id === spawning.id)).toBe(true);
    expect(engine.state.players[0]!.score).toBe(500);
    expect(engine.state.players[0]!.kills).toEqual([0, 0, 0, 0]);
  });

  it('does not expire an uncollected power-up', () => {
    const engine = game();
    engine.state.powerUp = { kind: 'star', x: 24, y: 24 };
    advance(engine, 1800);
    expect(engine.state.powerUp?.kind).toBe('star');
  });

  it('requires a power-up to be within twelve pixels of the player center', () => {
    const engine = game();
    const tank = engine.state.tanks[0]!;
    engine.state.powerUp = { kind: 'star', x: tank.x + 12, y: tank.y };
    engine.step([]);
    expect(engine.state.powerUp).not.toBeNull();
    engine.state.powerUp!.x--;
    engine.step([]);
    expect(engine.state.powerUp).toBeNull();
  });

  it('aligns timers to the shared 64-frame counter rather than resetting its phase', () => {
    const engine = game();
    engine.state.tick = 62;
    const tank = engine.state.tanks[0]!;
    engine.state.powerUp = { kind: 'timer', x: tank.x, y: tank.y };
    engine.step([]);
    expect(engine.state.freezeTicks).toBe(577);
    advance(engine, 577);
    expect(engine.state.freezeTicks).toBe(0);
  });
});

describe('waves and authentic map spawn entries', () => {
  it.each(['single', 'coop'] as const)('reserves a %s enemy gun across slot reuse until the old shot finishes its impact', mode => {
    const engine = game(mode);
    const context: CoreContext = { state: engine.state, events: [], nextId: () => shotId++ };
    engine.state.spawnTimer = 0;
    updateSpawning(context);
    const original = engine.state.tanks.find(tank => tank.team === 'enemy')!;
    Object.assign(original, { spawnTicks: 0, x: 32, y: 160, direction: 'up' });
    fireBullet(context, original);
    const oldShot = engine.state.bullets[0]!;
    expect(oldShot.enemySlot).toBe(mode === 'single' ? 3 : 5);
    destroyEnemy(context, original, null);
    engine.state.spawnTimer = 0;
    updateSpawning(context);
    const replacement = engine.state.tanks.find(tank => tank.team === 'enemy')!;
    Object.assign(replacement, { spawnTicks: 0, x: 96, y: 32, direction: 'left' });
    expect(replacement.enemySlot).toBe(original.enemySlot);
    expect(replacement.id).not.toBe(original.id);
    const gunShots = () => engine.state.bullets.filter(bullet => bullet.team === 'enemy' && bullet.enemySlot === replacement.enemySlot);
    fireBullet(context, replacement);
    expect(gunShots()).toEqual([oldShot]);

    engine.state.spawnTimer = 0;
    updateSpawning(context);
    const other = engine.state.tanks.find(tank => tank.team === 'enemy' && tank !== replacement)!;
    Object.assign(other, { spawnTicks: 0, x: 160, y: 64, direction: 'right' });
    fireBullet(context, other);
    expect(other.enemySlot).not.toBe(original.enemySlot);
    expect(engine.state.bullets).toHaveLength(2);
    expect(engine.state.bullets[1]).toMatchObject({ enemySlot: other.enemySlot });
    updateBullets(context);
    expect(oldShot.y).toBe(158);
    expect(oldShot.impactTicks).toBeUndefined();

    engine.state.tiles[19 * 26 + 5] = Tile.Steel;
    updateBullets(context);
    expect(oldShot.impactTicks).toBe(9);
    fireBullet(context, replacement);
    expect(gunShots()).toEqual([oldShot]);
    for (let tick = 0; tick < 8; tick++) updateBullets(context);
    expect(oldShot.impactTicks).toBe(1);
    fireBullet(context, replacement);
    expect(gunShots()).toEqual([oldShot]);
    expect(context.events.filter(event => event.type === 'fire')).toHaveLength(2);
    updateBullets(context);
    expect(gunShots()).toHaveLength(0);
    fireBullet(context, replacement);
    expect(gunShots()).toHaveLength(1);
    expect(gunShots()[0]).toMatchObject({ enemySlot: original.enemySlot });
    expect(context.events.filter(event => event.type === 'fire')).toHaveLength(3);
  });

  it.each([['single', 4], ['coop', 6]] as const)('allocates and reuses the highest free %s enemy slot', (mode, maximum) => {
    const engine = game(mode);
    for (let index = 0; index < maximum; index++) {
      engine.state.spawnTimer = 0;
      engine.step([]);
    }
    const enemies = engine.state.tanks.filter(tank => tank.team === 'enemy');
    expect(enemies.map(tank => tank.enemySlot)).toEqual(Array.from({ length: maximum }, (_, index) => maximum - index - 1));
    expect(enemies.every(tank => tank.spawnTicks > 0)).toBe(true);
    engine.state.spawnTimer = 0;
    engine.step([]);
    expect(engine.state.spawned).toBe(maximum);
    // Destroy two occupied slots; birth-phase enemies also keep their slots.
    enemies.forEach((tank, index) => { tank.x = 24 + index * 24; tank.y = 64; });
    engine.state.freezeTicks = 10_000;
    for (const tank of enemies.slice(0, 2)) {
      tank.spawnTicks = 0;
      shot(engine, tank.x + 8, tank.y - 2);
    }
    engine.step([]);
    expect(engine.state.killed).toBe(2);
    engine.step([]);
    const firstReplacement = engine.state.tanks.find(tank => tank.team === 'enemy' && tank.enemySlot === maximum - 1)!;
    expect(firstReplacement.id).not.toBe(enemies[0]!.id);
    expect(firstReplacement.spawnTicks).toBe(28);
    expect(firstReplacement.x).toBe([96, 192, 0][maximum % 3]);
    engine.state.spawnTimer = 0;
    engine.step([]);
    expect(engine.state.tanks.filter(tank => tank.team === 'enemy').map(tank => tank.enemySlot).sort()).toEqual(
      Array.from({ length: maximum }, (_, index) => index));
  });

  it('uses fixed slot parity for birth and ordinary movement even when identity parity disagrees', () => {
    const engine = game();
    const evenSlot = enemy(engine, 'basic', 33, 33);
    const oddSlot = enemy(engine, 'basic', 97, 33);
    evenSlot.enemySlot = 0;
    evenSlot.id = 101;
    oddSlot.enemySlot = 1;
    oddSlot.id = 102;
    evenSlot.spawnTicks = oddSlot.spawnTicks = 2;
    engine.state.freezeTicks = 0;
    engine.step([]);
    expect([evenSlot.spawnTicks, oddSlot.spawnTicks]).toEqual([1, 2]);
    engine.step([]);
    expect([evenSlot.spawnTicks, oddSlot.spawnTicks]).toEqual([1, 1]);
    engine.step([]);
    expect([evenSlot.spawnTicks, oddSlot.spawnTicks]).toEqual([0, 1]);
    expect([evenSlot.y, oddSlot.y]).toEqual([34, 33]);
    engine.step([]);
    expect([evenSlot.y, oddSlot.y]).toEqual([34, 34]);
    engine.step([]);
    expect([evenSlot.y, oddSlot.y]).toEqual([35, 34]);
  });

  it.each([0, 1])('follows the player selected by enemy slot %s instead of object identity', slot => {
    const engine = game('coop');
    engine.state.tanks[0]!.x = engine.state.tanks[0]!.y = 16;
    engine.state.tanks[1]!.x = engine.state.tanks[1]!.y = 144;
    const tank = enemy(engine, 'fast', 80, 80);
    tank.enemySlot = slot;
    tank.id = 101 + slot;
    engine.state.tick = 120 + 24 * 256;
    const initialRng = engine.state.rng;
    chooseEnemyDirection(engine.state, tank);
    const direction = tank.direction;
    expect(slot === 0 ? ['up', 'left'] : ['down', 'right']).toContain(direction);
    tank.id++;
    engine.state.rng = initialRng;
    chooseEnemyDirection(engine.state, tank);
    expect(tank.direction).toBe(direction);
  });

  it('keeps enemy behavior identical despite extra identity allocations and cosmetic effects', () => {
    const first = game();
    const second = game();
    // A genuine shot allocates an ID; discard it to isolate identity history.
    first.step([input({ firePressed: true })]);
    second.step([]);
    first.state.bullets = [];
    first.state.effects.push({ kind: 'explosion', x: 32, y: 32, remainingTicks: 24 });
    for (const engine of [first, second]) {
      engine.state.spawnTimer = 0;
      engine.step([]);
    }
    const firstEnemy = first.state.tanks.find(tank => tank.team === 'enemy')!;
    const secondEnemy = second.state.tanks.find(tank => tank.team === 'enemy')!;
    expect(firstEnemy.id).not.toBe(secondEnemy.id);
    expect(firstEnemy.id & 1).not.toBe(secondEnemy.id & 1);
    expect(firstEnemy.enemySlot).toBe(secondEnemy.enemySlot);
    for (let tick = 0; tick < 120; tick++) expect(first.step([])).toEqual(second.step([]));
    expect(first.state.tanks.map(tank => ({ ...tank, id: 0 }))).toEqual(second.state.tanks.map(tank => ({ ...tank, id: 0 })));
    expect(first.state.bullets.map(bullet => ({ ...bullet, id: 0 }))).toEqual(
      second.state.bullets.map(bullet => ({ ...bullet, id: 0 })));
    expect(first.state.rng).toBe(second.state.rng);
  });

  it.each(['basic', 'fast', 'power', 'armor'] as const)('uses original movement cadence for a %s enemy', kind => {
    const engine = game();
    const tank = enemy(engine, kind, 32, 32);
    engine.state.freezeTicks = 0;
    let distance = 0;
    for (let frame = 0; frame < 4; frame++) {
      const { x, y } = tank;
      engine.step([]);
      distance += Math.abs(tank.x - x) + Math.abs(tank.y - y);
    }
    expect(distance).toBe(kind === 'fast' ? 4 : 2);
  });

  it.each([5, 12])('clears the runtime birth block on original stage %s without changing its map', stage => {
    const definition = getLevel(stage);
    const engine = new GameEngine(definition, { mode: 'single', stage });
    expect(definition.tiles[12]).toBe(Tile.Brick);
    advance(engine, 121);
    expect(engine.state.spawned).toBe(1);
    expect(engine.state.tiles[12]).toBe(Tile.Empty);
    expect(definition.tiles[12]).toBe(Tile.Brick);
  });

  it('preserves the original entry sequence when a player camps on the next birth block', () => {
    const engine = game();
    engine.state.tanks[0]!.x = 96;
    engine.state.tanks[0]!.y = 0;
    engine.state.spawnTimer = 0;
    engine.step([]);
    expect(engine.state.spawned).toBe(1);
    expect(engine.state.tanks.find(tank => tank.team === 'enemy')!.x).toBe(96);
    expect(engine.state.tanks[0]!.x).toBe(96);
  });

  it('allows both tanks to escape an existing spawn overlap without walking into new tanks', () => {
    const engine = game();
    const player = engine.state.tanks[0]!;
    player.x = 96;
    player.y = 0;
    engine.state.spawnTimer = 0;
    engine.step([]);
    const born = engine.state.tanks.find(tank => tank.team === 'enemy')!;
    expect(born.x).toBe(player.x);
    born.direction = 'right';
    player.direction = 'left';
    expect(moveTank(engine.state, player)).toBe(true);
    expect(moveTank(engine.state, born)).toBe(true);
    expect(player.x).toBe(95);
    expect(born.x).toBe(97);
    player.x = 64;
    born.x = 80;
    player.direction = 'right';
    expect(moveTank(engine.state, player)).toBe(false);
  });

  it('spawns a player at the original birth block even if another tank occupies it', () => {
    const engine = game('coop');
    const player = engine.state.players[0]!;
    engine.state.tanks = [engine.state.tanks[1]!];
    engine.state.tanks[0]!.x = 64;
    engine.state.tanks[0]!.y = 192;
    player.respawnTicks = 1;
    engine.step([]);
    expect(engine.state.tanks.filter(tank => tank.x === 64 && tank.y === 192)).toHaveLength(2);
  });

  it('progresses from following a player to aiming toward the base as stage time advances', () => {
    const engine = game();
    const tank = enemy(engine, 'fast', 32, 32);
    engine.state.tanks[0]!.x = 0;
    engine.state.tanks[0]!.y = 0;
    engine.state.tick = 120 + 24 * 256;
    chooseEnemyDirection(engine.state, tank);
    expect(['up', 'left']).toContain(tank.direction);
    engine.state.tick = 120 + 47 * 256;
    chooseEnemyDirection(engine.state, tank);
    expect(['down', 'right']).toContain(tank.direction);
  });

  it('awards the cooperative stage bonus to the player with more kills, never on a tie', () => {
    const engine = game('coop');
    engine.state.players[0]!.kills = [1, 0, 0, 0];
    engine.state.spawned = engine.state.enemyQueue.length;
    engine.state.killed = engine.state.enemyQueue.length;
    advance(engine, 128);
    expect(engine.state.phase).toBe('won');
    expect(engine.state.players.map(player => player.score)).toEqual([1000, 0]);
    const tied = game('coop');
    tied.state.spawned = tied.state.enemyQueue.length;
    tied.state.killed = tied.state.enemyQueue.length;
    advance(tied, 128);
    expect(tied.state.players.map(player => player.score)).toEqual([0, 0]);
  });

  it.each([['single', 4], ['coop', 6]] as const)('limits %s waves to %s simultaneous enemies', (mode, maximum) => {
    const engine = game(mode);
    engine.state.spawnTimer = 0;
    for (let index = 0; index < 7; index++) {
      // Move existing enemies off the three entry positions and freeze AI.
      const enemies = engine.state.tanks.filter(tank => tank.team === 'enemy');
      enemies.forEach((tank, order) => { tank.x = order * 24; tank.y = 48; tank.spawnTicks = 0; });
      engine.state.freezeTicks = 10_000;
      engine.state.spawnTimer = 0;
      engine.step([]);
    }
    expect(engine.state.tanks.filter(tank => tank.team === 'enemy')).toHaveLength(maximum);
    expect(engine.state.spawned).toBe(maximum);
  });

  it('finishes a complete 20-enemy wave and awards exactly its kill scores', () => {
    const engine = game();
    engine.state.spawnTimer = 0;
    engine.state.freezeTicks = 10_000;
    for (let tick = 0; tick < 5000 && engine.state.phase === 'playing'; tick++) {
      for (const tank of engine.state.tanks.filter(candidate => candidate.team === 'enemy' && candidate.spawnTicks === 0)) {
        shot(engine, tank.x + 8, tank.y + 18, { direction: 'up' });
      }
      engine.step([]);
    }
    expect(engine.state.spawned).toBe(20);
    expect(engine.state.killed).toBe(20);
    expect(engine.state.phase).toBe('won');
    expect(engine.state.players[0]!.score).toBe(2000);
  });

  it('uses stage 35 enemy difficulty after cycling to map 1 without inventing speed upgrades', () => {
    const definition = getLevel(36);
    const engine = new GameEngine(definition, { mode: 'single', stage: 36 });
    expect(engine.state.enemyQueue).toEqual(getLevel(35).enemies);
    engine.state.phase = 'playing';
    engine.step([]);
    expect(engine.state.spawnTimer).toBe(50);
  });

  it('restarts the original difficulty at stage 71 while preserving the player carry', () => {
    const carry = { score: 42_000, lives: 4, stars: 3, nextExtraLife: Infinity, eliminated: false };
    const engine = new GameEngine(getLevel(71), { mode: 'single', stage: 71, players: [carry] });
    expect(engine.state.stage).toBe(1);
    expect(engine.state.enemyQueue).toEqual(getLevel(1).enemies);
    expect(engine.state.players[0]).toMatchObject(carry);
    engine.state.phase = 'playing';
    engine.step([]);
    expect(engine.state.spawnTimer).toBe(186);
    expect(spawnInterval(71, 'single')).toBe(186);
    expect(spawnInterval(71, 'coop')).toBe(166);
  });
});
