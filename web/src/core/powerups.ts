import { randomInt } from './random';
import { FORTIFY_TICKS, FREEZE_TICKS, HELMET_TICKS, POWER_UP_TABLE, timerDuration } from './rules';
import { addScore } from './scoring';
import { setFortress } from './terrain';
import { type CoreContext, Tile, type GameState, type Tank } from './types';

function pickupRange(tank: Tank, x: number, y: number): boolean {
  return tank.team === 'player' && tank.spawnTicks === 0 && tank.deathTimer === 0 && Math.abs(tank.x - x) < 12 && Math.abs(tank.y - y) < 12;
}

/** The original bonus and its pickup points share one display slot. */
export function clearPowerUp(state: GameState): void {
  state.powerUp = null;
  state.effects = state.effects.filter(effect => effect.value !== 500);
}

export function dropPowerUp(context: CoreContext): void {
  const state = context.state;
  let x = 24, y = 24, free = false;
  const occupied = (x: number, y: number) => state.tanks.some(tank => pickupRange(tank, x, y));
  for (let attempt = 0; attempt < 32; attempt++) {
    x = 24 + randomInt(state, 4) * 48; y = 24 + randomInt(state, 4) * 48;
    if (!occupied(x, y)) { free = true; break; }
  }
  if (!free) {
    search: for (let yy = 24; yy <= 168; yy += 48) for (let xx = 24; xx <= 168; xx += 48) {
      if (!occupied(xx, yy)) { x = xx; y = yy; free = true; break search; }
    }
    if (!free) throw new Error('No free bonus position');
  }
  clearPowerUp(state);
  // Uncollected items persist; a carrier birth or a later drop can replace them.
  state.powerUp = { kind: POWER_UP_TABLE[randomInt(state, POWER_UP_TABLE.length)]!, x, y };
  context.events.push({ type: 'powerup', action: 'appear', kind: state.powerUp.kind, playerIndex: null });
}

export function collectPowerUp(context: CoreContext,
  destroyEnemy: (tank: Tank, playerIndex: number | null) => void): void {
  const state = context.state;
  const powerUp = state.powerUp;
  if (!powerUp) return;
  // E972 checks player two before player one, independently of tank insertion order.
  const playerTank = [1, 0].map(index => state.tanks.find(tank => tank.team === 'player' &&
    tank.playerIndex === index && pickupRange(tank, powerUp.x, powerUp.y))).find(Boolean);
  if (!playerTank || playerTank.playerIndex === null) return;
  const player = state.players[playerTank.playerIndex]!;
  clearPowerUp(state);
  addScore(context, player.index, 500);
  state.effects.push({ x: powerUp.x + 8, y: powerUp.y + 8, remainingTicks: 50, value: 500 });
  context.events.push({ type: 'powerup', action: 'pickup', kind: powerUp.kind, playerIndex: player.index });
  switch (powerUp.kind) {
    case 'helmet': playerTank.shieldTicks = timerDuration(HELMET_TICKS, state.tick); break;
    case 'timer': state.freezeTicks = timerDuration(FREEZE_TICKS, state.tick); break;
    case 'shovel':
      if (state.baseAlive) {
        state.fortifyTicks = timerDuration(FORTIFY_TICKS, state.tick);
        setFortress(state, Tile.Steel);
      }
      break;
    case 'star':
      player.stars = Math.min(3, player.stars + 1);
      playerTank.stars = player.stars;
      break;
    case 'grenade':
      // NES EA17–EA3D destroys carriers without spawning their bonus;
      // bonus drops belong to bullet hits (E7D1–E7E0), not destruction.
      // Grenades remove active enemies without kill-score credit. The
      // 500 points for picking up the item still belong to the collector.
      for (const tank of [...state.tanks]) {
        if (tank.team === 'enemy' && tank.spawnTicks === 0 && tank.deathTimer === 0) destroyEnemy(tank, null);
      }
      break;
    case 'tank':
      player.lives++;
      context.events.push({ type: 'extra-life', playerIndex: player.index, reason: 'powerup' });
      break;
  }
}

export function updatePowerUpTimers(context: CoreContext): void {
  const state = context.state;
  if (state.freezeTicks > 0) state.freezeTicks--;
  if (state.fortifyTicks > 0) {
    state.fortifyTicks--;
    if (state.fortifyTicks === 0) setFortress(state, Tile.Brick);
    else if (state.fortifyTicks <= 3 * 64 && (state.tick & 15) === 0) {
      // The final three 64-frame timer units alternate real brick/steel.
      setFortress(state, (state.tick & 16) ? Tile.Steel : Tile.Brick);
    }
  }
}
