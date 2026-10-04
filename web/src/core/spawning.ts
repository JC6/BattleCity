import { TANK_SIZE } from './constants';
import type { CoreContext } from './context';
import { SPAWN_SHIELD_TICKS, SPAWN_TICKS, enemyMovementTick, maximumEnemies, playerMovementTick, spawnInterval, timerDuration } from './rules';
import { forEachTile } from './terrain';
import { Tile, type EnemyKind, type Tank } from './types';

function createTank(context: CoreContext, team: Tank['team'], index: 0 | 1 | null,
  kind: EnemyKind, x: number, y: number, enemySlot: number | null): Tank {
  return {
    id: context.nextId(), team, playerIndex: index, enemySlot, kind, x, y,
    direction: team === 'player' ? 'up' : 'down',
    hp: kind === 'armor' ? 4 : 1,
    stars: index === null ? 0 : context.state.players[index]!.stars,
    shieldTicks: 0, spawnTicks: SPAWN_TICKS,
    stunTicks: 0, aiTicks: 0, slideTicks: 0, moving: false,
    carryingPowerUp: false,
  };
}

function clearSpawnTerrain(context: CoreContext, x: number, y: number): void {
  // Spawning clears the tank's 16px block.
  // Some authentic maps deliberately contain brick at the top entries.
  forEachTile({ x, y, width: TANK_SIZE, height: TANK_SIZE }, index => {
    context.state.tiles[index] = Tile.Empty;
    context.state.brickMasks[index] = 0;
  });
}

export function spawnPlayer(context: CoreContext, index: 0 | 1): void {
  const x = index === 0 ? 64 : 128;
  const y = 192;
  clearSpawnTerrain(context, x, y);
  context.state.tanks.push(createTank(context, 'player', index, 'basic', x, y, null));
  context.state.players[index]!.respawnTicks = 0;
}

export function updateSpawning(context: CoreContext): void {
  const state = context.state;
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (state.tanks.some(tank => tank.playerIndex === player.index && tank.team === 'player')) continue;
    if (player.respawnTicks > 1) player.respawnTicks--;
    else if (player.respawnTicks === 1) spawnPlayer(context, player.index);
  }
  if (state.spawnTimer > 0) state.spawnTimer--;
  const enemies = state.tanks.filter(tank => tank.team === 'enemy');
  const maximum = maximumEnemies(state.mode);
  if (state.spawnTimer > 0 || state.spawned >= state.enemyQueue.length ||
      enemies.length >= maximum) return;

  // Allocate the highest free enemy slot, including tanks still spawning.
  let enemySlot = maximum - 1;
  while (enemies.some(tank => tank.enemySlot === enemySlot)) enemySlot--;

  // Spawn entries cycle through center, right, left, even when occupied.
  // canOccupy permits reducing an existing overlap so both tanks can leave.
  const x = [96, 192, 0][state.spawned % 3]!;
  clearSpawnTerrain(context, x, 0);
  const tank = createTank(context, 'enemy', null, state.enemyQueue[state.spawned]!, x, 0, enemySlot);
  tank.carryingPowerUp = [4, 11, 18].includes(state.spawned + 1);
  if (tank.carryingPowerUp) state.powerUp = null;
  state.tanks.push(tank);
  state.spawned++;
  state.spawnTimer = spawnInterval(state.stage, state.mode);
}

export function updateTankTimers(context: CoreContext): void {
  for (const tank of context.state.tanks) {
    if (tank.spawnTicks > 0) {
      // All enemies advance their two 14-step spawning phases on alternate
      // frames, even fast tanks.
      const advance = tank.team === 'player' ? playerMovementTick(context.state.tick) :
        enemyMovementTick(context.state.tick, tank.enemySlot!);
      if (advance) tank.spawnTicks--;
      if (tank.spawnTicks === 0 && tank.team === 'player') {
        tank.shieldTicks = timerDuration(SPAWN_SHIELD_TICKS, context.state.tick);
      }
    } else if (tank.shieldTicks > 0) tank.shieldTicks--;
  }
}
