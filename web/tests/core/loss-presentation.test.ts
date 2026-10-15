import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { LossPresentationWorld } from '../../src/core/loss-presentation';
import { SPAWN_TICKS } from '../../src/core/rules';
import { Tile, type Bullet, type EnemyKind, type GameMode, type GameState, type Tank } from '../../src/core/types';

function finalState(mode: GameMode = 'single'): GameState {
  const engine = new GameEngine({ tiles: Array(26 * 26).fill(Tile.Empty), enemies: Array(20).fill('basic') },
    { mode, stage: 1, seed: 123 });
  const state = engine.state;
  state.phase = 'lost';
  state.pendingOutcome = 'lost';
  state.baseAlive = false;
  state.introTicks = 0;
  state.spawnTimer = 100_000;
  for (const tank of state.tanks) {
    tank.spawnTicks = 0;
    tank.shieldTicks = 0;
  }
  return state;
}

function enemy(state: GameState, kind: EnemyKind = 'fast', x = 32, y = 40): Tank {
  const tank: Tank = {
    id: 100, team: 'enemy', playerIndex: null, enemySlot: 0, kind,
    x, y, direction: 'down', hp: 1, stars: 0, shieldTicks: 0,
    spawnTicks: 0, stunTicks: 0, aiTicks: 0, slideTicks: 0, moving: false,
    carryingPowerUp: false,
  };
  state.tanks.push(tank);
  return tank;
}

function bullet(state: GameState, values: Partial<Bullet> = {}): void {
  state.bullets.push({ id: 10_000, gunSlot: values.team === 'player' ? (values.playerIndex ?? 0) : 2,
    team: 'enemy', playerIndex: null,
    x: 24, y: 32, direction: 'right', speed: 2, steelPower: false, ...values });
}

function advance(world: LossPresentationWorld, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) world.step();
}

describe('isolated loss presentation', () => {
  it.each(['intro', 'playing', 'paused', 'won'] as const)('rejects %s instead of continuing a live engine', phase => {
    const state = finalState();
    state.phase = phase;
    expect(() => new LossPresentationWorld(state)).toThrow('finished loss');
  });

  it('deep-clones the terminal state, including an infinite score-life threshold', () => {
    const state = finalState();
    state.players[0]!.nextExtraLife = Infinity;
    const world = new LossPresentationWorld(state);
    expect(world.state).toEqual(state);
    expect(world.state).not.toBe(state);
    expect(world.state.players[0]).not.toBe(state.players[0]);
    expect(world.state.tanks[0]).not.toBe(state.tanks[0]);
    expect(world.state.tiles).not.toBe(state.tiles);
    expect(world.state.players[0]!.nextExtraLife).toBe(Infinity);
  });

  it('spawns new enemies and completes their birth animation using independent IDs', () => {
    const state = finalState();
    state.spawnTimer = 0;
    state.tiles[12] = Tile.Brick;
    state.brickMasks[12] = 15;
    bullet(state);
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    world.step();
    const born = world.state.tanks.find(tank => tank.team === 'enemy')!;
    expect(born).toMatchObject({ id: 10_001, enemySlot: 3, x: 96, y: 0, spawnTicks: SPAWN_TICKS });
    expect(world.state.spawned).toBe(1);
    expect(world.state.tiles[12]).toBe(Tile.Empty);
    advance(world, SPAWN_TICKS * 2);
    expect(born.spawnTicks).toBe(0);
    expect(world.state.phase).toBe('lost');
    expect(world.state.pendingOutcome).toBe('lost');
    expect(state).toEqual(before);
  });

  it('moves and fires existing enemies while preserving the original RNG and battlefield', () => {
    const state = finalState();
    enemy(state);
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    world.step();
    expect(world.state.tanks.find(tank => tank.id === 100)!.y).toBe(41);
    let fired = world.state.bullets.some(shot => shot.team === 'enemy');
    for (let tick = 0; tick < 120; tick++) {
      world.step();
      fired ||= world.state.bullets.some(shot => shot.team === 'enemy');
    }
    expect(fired).toBe(true);
    expect(world.state.rng).not.toBe(state.rng);
    expect(state).toEqual(before);
  });

  it('advances retained shots and expires effects without touching their source objects', () => {
    const state = finalState();
    bullet(state);
    state.effects.push({ kind: 'explosion', x: 24, y: 24, remainingTicks: 2 });
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    world.step();
    expect(world.state.bullets[0]!.x).toBe(26);
    expect(world.state.effects[0]!.remainingTicks).toBe(1);
    world.step();
    expect(world.state.bullets[0]!.x).toBe(28);
    expect(world.state.effects).toHaveLength(0);
    expect(state).toEqual(before);
  });

  it('keeps a newly fired terminal-animation shot at the barrel until its next logic frame', () => {
    const state = finalState();
    enemy(state, 'fast', 33, 40); // Off the 8px turn grid, so movement takes no random draw.
    state.rng = 34; // The next xorshift value is 9192480, divisible by 32: an accepted enemy shot.
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    world.step();
    expect(world.state.bullets).toHaveLength(1);
    expect(world.state.bullets[0]).toMatchObject({ gunSlot: 2, x: 41, y: 57, speed: 2 });
    world.step();
    expect(world.state.bullets[0]!.y).toBe(59);
    expect(state).toEqual(before);
  });

  it('uses ordinary collisions and explosions but keeps score-life rewards inside the discarded clone', () => {
    const state = finalState();
    state.baseAlive = true;
    state.tanks = [];
    Object.assign(state.players[0]!, { score: 19_900, lives: 0, eliminated: true, respawnTicks: 0 });
    state.spawned = state.enemyQueue.length;
    state.killed = state.enemyQueue.length - 1;
    state.freezeTicks = 1000;
    enemy(state, 'basic', 96, 80);
    bullet(state, { team: 'player', playerIndex: 0, x: 104, y: 70, direction: 'down' });
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    advance(world, 6);
    expect(world.state.tanks).toHaveLength(0);
    expect(world.state.killed).toBe(state.enemyQueue.length);
    expect(world.state.players[0]).toMatchObject({ score: 20_000, lives: 0, eliminated: true, respawnTicks: 0, nextExtraLife: 20_000 });
    expect(world.state.effects.some(effect => effect.kind === 'explosion')).toBe(true);
    expect(world.state.phase).toBe('lost');
    expect(world.state.pendingOutcome).toBe('lost');
    expect(state).toEqual(before);
  });

  it('does not move or fire players, collect their power-up, or respawn a missing partner', () => {
    const state = finalState('coop');
    state.tanks = state.tanks.filter(tank => tank.playerIndex === 0);
    state.players[1]!.respawnTicks = 1;
    state.powerUp = { kind: 'tank', x: 64, y: 192 };
    state.tanks[0]!.moving = true;
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    advance(world, 120);
    expect(world.state.tanks).toHaveLength(1);
    expect(world.state.tanks[0]).toMatchObject({ playerIndex: 0, x: 64, y: 192, moving: false });
    expect(world.state.bullets).toHaveLength(0);
    expect(world.state.powerUp).toEqual(state.powerUp);
    expect(world.state.players).toEqual(state.players);
    expect(state).toEqual(before);
  });

  it('never respawns a player killed by a retained shot in the animation', () => {
    const state = finalState();
    bullet(state, { x: 72, y: 191, direction: 'down' });
    const before = structuredClone(state);
    const world = new LossPresentationWorld(state);
    advance(world, 100);
    expect(world.state.tanks).toHaveLength(0);
    expect(world.state.players[0]).toMatchObject({ lives: 1, respawnTicks: 48 });
    expect(world.state.phase).toBe('lost');
    expect(state).toEqual(before);
  });

  it('evolves deterministic private worlds from the same snapshot', () => {
    const state = finalState();
    state.spawnTimer = 0;
    const before = structuredClone(state);
    const first = new LossPresentationWorld(state);
    const second = new LossPresentationWorld(state);
    advance(first, 120);
    advance(second, 120);
    expect(first.state).toEqual(second.state);
    expect(state).toEqual(before);
  });
});
