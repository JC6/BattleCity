import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { Tile, type GameMode, type GameState } from '../../src/core/types';
import type { ArenaScene } from '../../src/game/arena';

export function emptyWorld(mode: GameMode = 'single'): GameState {
  const state = new GameEngine(getLevel(1), { mode, stage: 1, seed: 1 }).state;
  state.tanks = []; state.tiles.fill(Tile.Empty); state.brickMasks.fill(0); state.tick = 0;
  return state;
}
export function entityWorld(): GameState {
  const engine = new GameEngine(getLevel(1), { mode: 'coop', stage: 2, seed: 1 });
  const template = { ...engine.state.tanks[0] };
  const state = emptyWorld('coop'); state.stage = 2;
  for (let mask = 0; mask < 16; mask++) { state.tiles[52 + mask] = Tile.Brick; state.brickMasks[52 + mask] = mask; }
  [Tile.Steel, Tile.Water, Tile.Ice, Tile.Forest].forEach((tile, index) => { state.tiles[78 + index] = tile; });
  state.tiles[24 * 26 + 12] = Tile.Forest; state.tiles[12 * 26 + 8] = Tile.Forest;
  state.tanks = Array.from({ length: 8 }, (_, index) => ({ ...template, id: index + 1,
    team: index < 2 ? 'player' as const : 'enemy' as const,
    playerIndex: index < 2 ? index as 0 | 1 : null, enemySlot: index < 2 ? null : index - 2,
    kind: (['basic', 'fast', 'power', 'armor'] as const)[index % 4], hp: index === 7 ? 1 : 4,
    stars: index % 4, x: 16 + index % 4 * 48, y: 80 + Math.floor(index / 4) * 48,
    direction: (['up', 'right', 'down', 'left'] as const)[index % 4], spawnTicks: index === 6 ? 12 : 0,
    shieldTicks: index === 0 ? 10 : 0, carryingPowerUp: index === 5,
  }));
  state.bullets = Array.from({ length: 5 }, (_, index) => ({ id: 40 + index, team: 'player' as const,
    playerIndex: 0 as const, gunSlot: (index % 2) as 0 | 1,
    x: index === 4 ? 120 : 24 + index * 32, y: index === 4 ? 192 : 64,
    direction: (['up', 'right', 'down', 'left'] as const)[index % 4], speed: 2, steelPower: false,
    ...(index === 4 ? { impactTicks: 5 } : {}),
  }));
  state.effects = [24, 16, 8].map((remainingTicks, index) => ({ kind: 'explosion' as const,
    x: 48 + index * 48, y: 156, remainingTicks }));
  state.effects.push({ kind: 'explosion', explosionVariant: 'base', x: 104, y: 200, remainingTicks: 8 });
  state.effects.push({ kind: 'points', x: 48, y: 136, remainingTicks: 40, value: 400 });
  state.powerUp = { kind: 'star', x: 160, y: 176 };
  state.players[0].lives = 3; state.players[1].lives = 8; state.spawned = 10;
  return state;
}
export interface RenderFixture { name: string; apply(scene: ArenaScene): void }
export function renderFixtures(): RenderFixture[] {
  const result: RenderFixture[] = [0, 1, 2].map(selection => ({ name: `menu-${selection}`, apply(scene) {
    scene.presentation = { kind: 'menu', selection: selection as 0 | 1 | 2, highScore: 20000, playerScores: [0] };
  } }));
  result.push({ name: 'stage-35', apply(scene) { scene.presentation = { kind: 'stage-select', stage: 35, mode: 'coop' }; } });
  for (const elapsedMs of [0, 500, 1000, 1500, 2000]) for (const paused of [false, true]) result.push({
    name: `intro-${elapsedMs}-${paused}`, apply(scene) { scene.presentation = { kind: 'intro', stage: 21, elapsedMs, paused }; },
  });
  for (const mode of ['single', 'coop'] as const) for (const elapsedMs of [0, 600, 1600, 6000]) result.push({
    name: `score-${mode}-${elapsedMs}`, apply(scene) {
      const state = emptyWorld(mode);
      state.players.forEach((player, index) => { player.kills = index ? [2, 1, 0, 3] : [1, 2, 3, 4]; player.score = index ? 54321 : 12345; });
      scene.presentation = { kind: 'score', state, highScore: 20000, elapsedMs };
    },
  });
  result.push({ name: 'gameover', apply(scene) { scene.presentation = { kind: 'gameover' }; } });
  for (const tick of [0, 16]) result.push({ name: `entities-${tick}`, apply(scene) {
    scene.state = { ...entityWorld(), tick }; scene.presentation = { kind: 'game' };
  } });
  result.push({ name: 'locked-hud', apply(scene) {
    scene.state = entityWorld(); scene.hudState = { ...structuredClone(scene.state), stage: 31, spawned: 19 };
    scene.hudState.players[0].lives = 0;
    scene.presentation = { kind: 'game', lossBannerProgress: 0.6, paused: true };
  } });
  result.push({ name: 'editor', apply(scene) {
    scene.draft = entityWorld().tiles; scene.presentation = { kind: 'editor', cursor: { x: 4, y: 12 } };
  } });
  return result;
}
