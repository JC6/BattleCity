import { BASE_X, BASE_Y } from './constants';
import { DIRECTIONS, opposite } from './geometry';
import { moveTank, turnTank } from './movement';
import { randomInt } from './random';
import { enemyMovementTick, spawnInterval } from './rules';
import type { GameState, Tank } from './types';

// Targeting chooses between an X-biased and Y-biased direction from relative signs.
const TARGET_DIRECTIONS = [
  ['up', 'up', 'up', 'left', 'up', 'right', 'down', 'down', 'down'],
  ['left', 'up', 'right', 'left', 'up', 'right', 'left', 'down', 'right'],
] as const;

export function chooseEnemyDirection(state: GameState, tank: Tank): void {
  const frameHigh = (Math.floor(state.battleTicks / 64) & 255);
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

function requestDirection(state: GameState, tank: Tank): void {
  const high = Math.floor(state.battleTicks / 64) & 255;
  if (high <= (spawnInterval(state.stage, state.mode) >> 3)) turnTank(state, tank, DIRECTIONS[randomInt(state, 4)]!);
  else tank.aiTarget = true;
}

export function moveEnemy(state: GameState, tank: Tank): void {
  tank.moving = false;
  if (state.freezeTicks > 0 || (tank.kind !== 'fast' && !enemyMovementTick(state.tick, tank.enemySlot!))) return;
  if (tank.aiTicks > 0) { tank.aiTicks--; return; }
  if (tank.aiTurn) {
    tank.aiTurn = false;
    if (randomInt(state, 2) === 0) requestDirection(state, tank);
    else {
      const direction = DIRECTIONS.indexOf(tank.direction);
      turnTank(state, tank, DIRECTIONS[(direction + (randomInt(state, 2) === 0 ? 3 : 1)) % 4]!);
    }
    return;
  }
  if (tank.aiTarget) { tank.aiTarget = false; chooseEnemyDirection(state, tank); return; }
  const aligned = (tank.x & 7) === 0 && (tank.y & 7) === 0;
  if (aligned && randomInt(state, 16) === 0) { requestDirection(state, tank); return; }
  if (moveTank(state, tank)) { tank.tread = tank.tread === 0 ? 1 : 0; return; }
  if (randomInt(state, 4) !== 0) { tank.aiTicks = 2; tank.tread = tank.tread === 0 ? 1 : 0; }
  else { tank.direction = opposite(tank.direction); tank.aiTurn = aligned; }
}
