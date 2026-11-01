import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { EMPTY_INPUT, Tile } from '../../src/core/types';

function battle(coop = false) {
  const game = new GameEngine({ tiles: Array(676).fill(Tile.Empty), enemies: Array(20).fill('basic') },
    { mode: coop ? 'coop' : 'single', stage: 1, seed: 123 });
  Object.assign(game.state, { phase: 'playing', introTicks: 0, spawnTimer: 100000 });
  game.state.tanks.forEach(tank => Object.assign(tank, { spawnTicks: 0, shieldTicks: 0 }));
  return game;
}
function step(game: GameEngine, ticks: number) { for (let i = 0; i < ticks; i++) game.step([EMPTY_INPUT, EMPTY_INPUT]); }

describe('authoritative failure battlefield', () => {
  it('waits for the HQ explosion before the 256-tick banner, without an extra scene', () => {
    const game = battle();
    Object.assign(game.state, { baseAlive: false, baseExplosionTicks: 39 });
    step(game, 38); expect(game.state.baseExplosionTicks).toBe(1); expect(game.state.lossBannerTicks).toBe(0);
    step(game, 1); expect(game.state.lossBannerTicks).toBe(256); expect(game.state.phase).toBe('playing');
    step(game, 255); expect(game.state.lossBannerTicks).toBe(1); expect(game.state.phase).toBe('playing');
    expect(game.step([EMPTY_INPUT])).toContainEqual({ type: 'game-over' });
    expect(game.state.phase).toBe('lost'); expect(game.step([EMPTY_INPUT])).toEqual([]);
  });
  it('keeps enemy movement, spawning and old-shot rewards authoritative while ignoring player movement and fire', () => {
    const game = battle(); game.state.baseAlive = false; game.state.spawnTimer = 0; step(game, 1);
    const player = game.state.tanks[0]; const origin = { x: player.x, y: player.y };
    for (let i = 0; i < 80; i++) game.step([{ ...EMPTY_INPUT, right: true, firePressed: true }]);
    expect(player).toMatchObject(origin); expect(player.moving).toBe(false);
    expect(game.state.spawned).toBe(1);
    const enemy = game.state.tanks.find(tank => tank.team === 'enemy')!;
    expect(enemy.spawnTicks).toBe(0); expect(enemy.y).toBeGreaterThan(0);
    expect(game.state.bullets.every(bullet => bullet.team === 'enemy')).toBe(true);
    expect(game.state.tick).toBe(81); expect(game.state.phase).toBe('playing');
  });
  it('starts final-player failure only after its death animation, and keeps a living partner in play', () => {
    for (const coop of [false, true]) {
      const game = battle(coop); const player = game.state.players[0]; player.lives = 0;
      game.state.tanks[0].deathTimer = 0x73;
      step(game, 23); expect(player.eliminated).toBe(false); expect(game.state.pendingOutcome).toBeNull();
      for (let i = 0; i < 100 && !player.eliminated; i++) step(game, 1);
      expect(player.eliminated).toBe(true);
      if (coop) { expect(game.state.pendingOutcome).toBeNull(); expect(game.state.eliminationTicks).toBe(208); }
      else { expect(game.state.pendingOutcome).toBe('lost'); expect(game.state.lossBannerTicks).toBe(256); }
    }
  });
  it('overrides a pending win with loss without restarting its existing wait', () => {
    const game = battle(); game.state.killed = 20; step(game, 1);
    expect(game.state.outroTicks).toBe(128); step(game, 10);
    game.state.baseAlive = false; step(game, 1);
    expect(game.state.pendingOutcome).toBe('lost'); expect(game.state.outroTicks).toBe(117);
    step(game, 117); expect(game.state.phase).toBe('lost');
  });
});
