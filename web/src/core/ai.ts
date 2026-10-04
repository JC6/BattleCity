import { BASE_X, BASE_Y } from './constants';
import { DIRECTIONS, opposite } from './geometry';
import { moveTank, turnTank } from './movement';
import { randomInt } from './random';
import { INTRO_TICKS, enemyMovementTick, spawnInterval } from './rules';
import type { GameState, Tank } from './types';

// Targeting chooses between an X-biased and Y-biased direction from relative signs.
const TARGET_DIRECTIONS = [
  ['up', 'up', 'up', 'left', 'up', 'right', 'down', 'down', 'down'],
  ['left', 'up', 'right', 'left', 'up', 'right', 'left', 'down', 'right'],
] as const;

export function chooseEnemyDirection(state: GameState, tank: Tank): void {
  const frameHigh = Math.floor(Math.max(0, state.tick - INTRO_TICKS) / 256);
  const interval = spawnInterval(state.stage, state.mode);
  if (frameHigh <= (interval >> 3)) {
    // Pick an absolute direction, each with probability 1/4.
    turnTank(state, tank, DIRECTIONS[randomInt(state, 4)]!);
    return;
  }
  let x = BASE_X;
  let y = BASE_Y;
  if (frameHigh <= (interval >> 2)) {
    const players = state.tanks.filter(candidate => candidate.team === 'player');
    const target = players.find(candidate => candidate.playerIndex === (tank.enemySlot! & 1)) ?? players[0];
    if (target) { x = target.x; y = target.y; }
  }
  const index = (Math.sign(y - tank.y) + 1) * 3 + Math.sign(x - tank.x) + 1;
  turnTank(state, tank, TARGET_DIRECTIONS[randomInt(state, 2)]![index]!);
}

export function moveEnemy(state: GameState, tank: Tank): void {
  if (state.freezeTicks > 0 || (tank.kind !== 'fast' && !enemyMovementTick(state.tick, tank.enemySlot!))) return;
  if ((tank.x & 7) === 0 && (tank.y & 7) === 0 && randomInt(state, 16) === 0) {
    // Enemies evolve from random roaming to following a player and finally
    // the base as the stage's frame counter crosses its two thresholds.
    chooseEnemyDirection(state, tank);
  }
  if (!moveTank(state, tank)) {
    tank.aiTicks++;
    if (randomInt(state, 4) === 0) tank.direction = opposite(tank.direction);
    else if (tank.aiTicks >= 8 && (tank.x & 7) === 0 && (tank.y & 7) === 0) {
      chooseEnemyDirection(state, tank);
      tank.aiTicks = 0;
    }
  } else tank.aiTicks = 0;
}
