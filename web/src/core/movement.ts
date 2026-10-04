import { TILE_SIZE } from './constants';
import { perpendicular, VECTORS } from './geometry';
import { ICE_SLIDE_STEPS, playerMovementTick } from './rules';
import { canOccupy, onIce } from './terrain';
import type { Direction, GameState, PlayerInput, Tank } from './types';

function inputDirection(input: PlayerInput): Direction | null {
  // Simultaneous inputs use right, left, down, up priority.
  if (input.right) return 'right';
  if (input.left) return 'left';
  if (input.down) return 'down';
  if (input.up) return 'up';
  return null;
}

export function turnTank(state: GameState, tank: Tank, direction: Direction): void {
  if (perpendicular(tank.direction, direction)) {
    const x = Math.round(tank.x / TILE_SIZE) * TILE_SIZE;
    const y = Math.round(tank.y / TILE_SIZE) * TILE_SIZE;
    // Never snap through a solid edge or another tank.
    if (canOccupy(state, tank, x, y)) {
      tank.x = x;
      tank.y = y;
    }
  }
  tank.direction = direction;
}

export function moveTank(state: GameState, tank: Tank): boolean {
  const [dx, dy] = VECTORS[tank.direction];
  const x = tank.x + dx;
  const y = tank.y + dy;
  tank.moving = canOccupy(state, tank, x, y);
  if (tank.moving) {
    tank.x = x;
    tank.y = y;
  }
  return tank.moving;
}

export function movePlayer(state: GameState, tank: Tank, input: PlayerInput): void {
  if (!playerMovementTick(state.tick)) return;
  if (tank.stunTicks > 0) {
    tank.stunTicks--;
    tank.slideTicks = 0;
    return;
  }
  const ice = onIce(state, tank);
  if (tank.slideTicks > 0) tank.slideTicks--;
  let direction = inputDirection(input);
  if (ice && tank.slideTicks > 16) direction = tank.direction;
  if (direction) {
    turnTank(state, tank, direction);
    if (moveTank(state, tank) && ice && tank.slideTicks === 0) tank.slideTicks = ICE_SLIDE_STEPS;
    else if (!ice || !tank.moving) tank.slideTicks = 0;
  } else if (ice && tank.slideTicks > 0) {
    if (!moveTank(state, tank)) tank.slideTicks = 0;
  } else {
    tank.slideTicks = 0;
  }
}
