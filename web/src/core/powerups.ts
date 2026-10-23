import type { CoreContext } from './context';
import { randomInt } from './random';
import { FORTIFY_TICKS, FREEZE_TICKS, HELMET_TICKS, POWER_UP_TABLE, timerDuration } from './rules';
import { addScore } from './scoring';
import { setFortress } from './terrain';
import { Tile, type Tank } from './types';

export function dropPowerUp(context: CoreContext): void {
  const state = context.state;
  let x = 24;
  let y = 24;
  // Choose one of four positions per axis. Retry positions
  // already under a player; brick/water/forest tiles do not block placement.
  for (let attempt = 0; attempt < 32; attempt++) {
    x = 24 + randomInt(state, 4) * 48;
    y = 24 + randomInt(state, 4) * 48;
    if (!state.tanks.some(tank => tank.team === 'player' &&
      Math.abs(tank.x - x) < 12 && Math.abs(tank.y - y) < 12)) break;
  }
  // The item remains until collected or replaced by another bonus tank.
  state.powerUp = {
    kind: POWER_UP_TABLE[randomInt(state, POWER_UP_TABLE.length)]!, x, y,
  };
  context.events.push({ type: 'powerup', action: 'appear', kind: state.powerUp.kind, playerIndex: null });
}

export function collectPowerUp(context: CoreContext,
  destroyEnemy: (tank: Tank, playerIndex: number | null) => void): void {
  const state = context.state;
  const powerUp = state.powerUp;
  if (!powerUp) return;
  // E972 checks player two before player one, independently of tank insertion order.
  const playerTank = [1, 0].map(index => state.tanks.find(tank => tank.team === 'player' &&
    tank.playerIndex === index && tank.spawnTicks === 0 &&
    Math.abs(tank.x - powerUp.x) < 12 && Math.abs(tank.y - powerUp.y) < 12)).find(Boolean);
  if (!playerTank || playerTank.playerIndex === null) return;
  const player = state.players[playerTank.playerIndex]!;
  state.powerUp = null;
  addScore(context, player.index, 500);
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
        if (tank.team === 'enemy' && tank.spawnTicks === 0) destroyEnemy(tank, null);
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
