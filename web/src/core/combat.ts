import { ARENA_SIZE, GRID_SIZE, TANK_SIZE, TILE_SIZE } from './constants';
import type { CoreContext } from './context';
import { overlaps, VECTORS } from './geometry';
import { randomInt } from './random';
import { ENEMY_KINDS, ENEMY_SCORE, FRIENDLY_STUN_TICKS, RESPAWN_TICKS } from './rules';
import { addScore } from './scoring';
import { BASE_RECT, brickIntersects, forEachTile } from './terrain';
import { dropPowerUp } from './powerups';
import { Tile, type Bullet, type Tank } from './types';

export function fireBullet(context: CoreContext, tank: Tank): void {
  const state = context.state;
  if (tank.spawnTicks > 0) return;
  const limit = tank.team === 'player' && tank.stars >= 2 ? 2 : 1;
  if (state.bullets.filter(bullet => tank.team === 'player'
    ? bullet.team === 'player' && bullet.playerIndex === tank.playerIndex
    : bullet.team === 'enemy' && bullet.enemySlot === tank.enemySlot).length >= limit) return;
  const [dx, dy] = VECTORS[tank.direction];
  const fast = tank.team === 'player' ? tank.stars > 0 : tank.kind === 'power';
  state.bullets.push({
    id: context.nextId(), team: tank.team, playerIndex: tank.playerIndex,
    enemySlot: tank.enemySlot,
    x: tank.x + 8 + dx * 8, y: tank.y + 8 + dy * 8,
    direction: tank.direction, speed: fast ? 4 : 2,
    steelPower: tank.team === 'player' && tank.stars === 3,
  });
  context.events.push({ type: 'fire' });
}

export function enemyFire(context: CoreContext, tank: Tank): void {
  if (context.state.freezeTicks === 0 && randomInt(context.state, 32) === 0) fireBullet(context, tank);
}

function effect(context: CoreContext, left: number, top: number, value?: number): void {
  context.state.effects.push({
    kind: value === undefined ? 'explosion' : 'points',
    x: left + TANK_SIZE / 2, y: top + TANK_SIZE / 2,
    remainingTicks: value === undefined ? 24 : 48,
    ...(value === undefined ? {} : { value }),
  });
}

export function destroyEnemy(context: CoreContext, tank: Tank, playerIndex: number | null): void {
  if (!context.state.tanks.includes(tank)) return;
  context.state.tanks = context.state.tanks.filter(other => other.id !== tank.id);
  context.state.killed++;
  effect(context, tank.x, tank.y);
  context.events.push({ type: 'explosion' });
  if (playerIndex !== null) {
    const player = context.state.players[playerIndex];
    if (player) {
      player.kills[ENEMY_KINDS.indexOf(tank.kind)]!++;
      const value = ENEMY_SCORE[tank.kind];
      addScore(context, playerIndex, value);
      effect(context, tank.x, tank.y, value);
    }
  }
}

function hitTank(context: CoreContext, tank: Tank, bullet: Bullet): void {
  if (tank.spawnTicks > 0 || tank.shieldTicks > 0) return;
  if (tank.team === 'player') {
    if (bullet.team === 'player') {
      if (tank.stunTicks === 0) tank.stunTicks = FRIENDLY_STUN_TICKS;
      context.events.push({ type: 'hit' });
      return;
    }
    const player = context.state.players[tank.playerIndex!]!;
    player.stars = 0;
    if (player.lives > 0) {
      player.lives--;
      player.respawnTicks = RESPAWN_TICKS;
    } else {
      player.respawnTicks = 0;
      player.eliminated = true;
    }
    context.state.tanks = context.state.tanks.filter(other => other.id !== tank.id);
    effect(context, tank.x, tank.y);
    context.events.push({ type: 'explosion' });
  } else {
    if (tank.carryingPowerUp) {
      tank.carryingPowerUp = false;
      dropPowerUp(context);
    }
    tank.hp--;
    if (tank.hp === 0) destroyEnemy(context, tank, bullet.playerIndex);
    else context.events.push({ type: 'hit' });
  }
}

function hitTerrain(context: CoreContext, bullet: Bullet): boolean {
  const state = context.state;
  const rect = { x: bullet.x - 2, y: bullet.y - 2, width: 4, height: 4 };
  if (bullet.x < 0 || bullet.y < 0 || bullet.x >= ARENA_SIZE || bullet.y >= ARENA_SIZE) {
    context.events.push({ type: 'hit' });
    return true;
  }
  if (state.baseAlive && overlaps(rect, BASE_RECT)) {
    state.baseAlive = false;
    effect(context, BASE_RECT.x, BASE_RECT.y);
    context.events.push({ type: 'explosion' });
    return true;
  }
  const hit = new Set<number>();
  forEachTile(rect, (index, x, y) => {
    if (state.tiles[index] === Tile.Steel || (state.tiles[index] === Tile.Brick &&
        brickIntersects(state.brickMasks[index]!, x, y, rect))) hit.add(index);
  });
  if (hit.size === 0) return false;

  // Once the leading probe hits brick, side probes damage the same 4px
  // layer on both sides of the barrel, rather than erasing a 16px block.
  const vertical = bullet.direction === 'up' || bullet.direction === 'down';
  const blast = {
    x: bullet.x - (vertical ? 4 : 2), y: bullet.y - (vertical ? 2 : 4),
    width: vertical ? 8 : 4, height: vertical ? 4 : 8,
  };
  forEachTile(blast, (index, x, y) => {
    if (state.tiles[index] === Tile.Brick && brickIntersects(state.brickMasks[index]!, x, y, blast)) {
      hit.add(index);
    }
  });
  for (const index of hit) {
    if (state.tiles[index] === Tile.Steel) {
      if (bullet.steelPower) {
        state.tiles[index] = Tile.Empty;
        state.brickMasks[index] = 0;
      }
    } else if (state.tiles[index] === Tile.Brick) {
      const clearMask = bullet.steelPower ? 15 :
        ({ up: 12, down: 3, left: 10, right: 5 } as const)[bullet.direction];
      state.brickMasks[index] = state.brickMasks[index]! & ~clearMask;
      // A second hit can arrive through the already-cleared near half.
      // Destroy the remaining far half when that is the actual contact.
      if (state.brickMasks[index] && brickIntersects(state.brickMasks[index]!,
        (index % GRID_SIZE) * TILE_SIZE, Math.floor(index / GRID_SIZE) * TILE_SIZE, rect)) {
        state.brickMasks[index] = 0;
      }
      if (state.brickMasks[index] === 0) state.tiles[index] = Tile.Empty;
    }
  }
  context.events.push({ type: 'hit' });
  return true;
}

export function updateBullets(context: CoreContext): void {
  const state = context.state;
  for (const bullet of state.bullets) {
    if (bullet.impactTicks) bullet.impactTicks--;
  }
  state.bullets = state.bullets.filter(bullet => bullet.impactTicks !== 0);
  const removed = new Set<number>();
  const vanished = new Set<number>();
  // One-pixel sweeps prevent 4px fast shots crossing tanks or partially
  // destroyed walls without a hit. Opposing shots are checked each sweep.
  const maximumSpeed = Math.max(0, ...state.bullets.filter(bullet => !bullet.impactTicks).map(bullet => bullet.speed));
  for (let substep = 0; substep < maximumSpeed; substep++) {
    for (const bullet of state.bullets) {
      if (bullet.impactTicks || removed.has(bullet.id) || substep >= bullet.speed) continue;
      const [dx, dy] = VECTORS[bullet.direction];
      bullet.x += dx;
      bullet.y += dy;
      if (hitTerrain(context, bullet)) {
        removed.add(bullet.id);
        continue;
      }
      for (const other of state.bullets) {
        if (other.impactTicks || other.id === bullet.id || removed.has(other.id) ||
            (other.team === 'enemy' && bullet.team === 'enemy') ||
            (other.team === 'player' && bullet.team === 'player' && other.playerIndex === bullet.playerIndex)) continue;
        if (Math.abs(other.x - bullet.x) < 6 && Math.abs(other.y - bullet.y) < 6) {
          removed.add(bullet.id);
          removed.add(other.id);
          vanished.add(bullet.id);
          vanished.add(other.id);
          break;
        }
      }
      if (removed.has(bullet.id)) continue;
      const tank = state.tanks.find(target => target.spawnTicks === 0 &&
        !(target.team === 'player' && bullet.team === 'player' && target.playerIndex === bullet.playerIndex) &&
        !(target.team === 'enemy' && bullet.team === 'enemy') &&
        Math.abs(target.x + 8 - bullet.x) < 10 && Math.abs(target.y + 8 - bullet.y) < 10);
      if (tank) {
        if (tank.shieldTicks > 0) vanished.add(bullet.id);
        hitTank(context, tank, bullet);
        removed.add(bullet.id);
      }
    }
  }
  for (const bullet of state.bullets) {
    if (removed.has(bullet.id) && !vanished.has(bullet.id)) bullet.impactTicks = 9;
  }
  state.bullets = state.bullets.filter(bullet => !vanished.has(bullet.id));
}

export function updateEffects(context: CoreContext): void {
  for (const item of context.state.effects) item.remainingTicks--;
  context.state.effects = context.state.effects.filter(item => item.remainingTicks > 0);
}
