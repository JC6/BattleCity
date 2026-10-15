import { ARENA_SIZE, GRID_SIZE, TANK_SIZE, TILE_SIZE } from './constants';
import type { CoreContext } from './context';
import { VECTORS } from './geometry';
import { randomInt } from './random';
import { ENEMY_KINDS, ENEMY_SCORE, FRIENDLY_STUN_TICKS, RESPAWN_TICKS } from './rules';
import { addScore } from './scoring';
import { BASE_RECT } from './terrain';
import { dropPowerUp } from './powerups';
import { Tile, type Bullet, type GunSlot, type Tank } from './types';

/** Original tank index and its primary gun share slots 0–7. */
export function tankSlot(tank: Tank): GunSlot {
  return (tank.team === 'player' ? tank.playerIndex! : tank.enemySlot! + 2) as GunSlot;
}

export function fireBullet(context: CoreContext, tank: Tank): void {
  const state = context.state;
  if (tank.spawnTicks > 0) return;
  const primarySlot = tankSlot(tank);
  const primary = state.bullets.find(bullet => bullet.gunSlot === primarySlot);
  if (primary) {
    const secondarySlot = (primarySlot + 8) as GunSlot;
    if (tank.team !== 'player' || tank.stars < 2 ||
      state.bullets.some(bullet => bullet.gunSlot === secondarySlot)) return;
    // E122 copies the entire occupied primary (even an impact) into 8/9,
    // then fires from 0/1. A surviving secondary cannot block a downgraded primary.
    primary.gunSlot = secondarySlot;
  }
  const [dx, dy] = VECTORS[tank.direction];
  const fast = tank.team === 'player' ? tank.stars > 0 : tank.kind === 'power';
  state.bullets.push({
    id: context.nextId(), gunSlot: primarySlot, team: tank.team, playerIndex: tank.playerIndex,
    x: tank.x + 8 + dx * 8, y: tank.y + 8 + dy * 8,
    direction: tank.direction, speed: fast ? 4 : 2,
    steelPower: tank.team === 'player' && tank.stars === 3,
  });
  context.events.push({ type: 'fire', team: tank.team, playerIndex: tank.playerIndex,
    enemyKind: tank.team === 'enemy' ? tank.kind : null, stars: tank.stars });
}

export function enemyFire(context: CoreContext, tank: Tank): void {
  if (tank.spawnTicks === 0 && context.state.freezeTicks === 0 && randomInt(context.state, 32) === 0) fireBullet(context, tank);
}

function effect(context: CoreContext, left: number, top: number, value?: number,
  explosionVariant: 'tank' | 'base' = 'tank'): void {
  context.state.effects.push({
    kind: value === undefined ? 'explosion' : 'points',
    x: left + TANK_SIZE / 2, y: top + TANK_SIZE / 2,
    remainingTicks: value === undefined ? 24 : 48,
    ...(value === undefined ? { explosionVariant } : { value }),
  });
}

export function destroyEnemy(context: CoreContext, tank: Tank, playerIndex: number | null): void {
  if (!context.state.tanks.includes(tank)) return;
  context.state.tanks = context.state.tanks.filter(other => other.id !== tank.id);
  context.state.killed++;
  effect(context, tank.x, tank.y);
  context.events.push({ type: 'explosion', owner: 'enemy', playerIndex: null, enemyKind: tank.kind });
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
      context.events.push({ type: 'hit', target: 'tank', team: bullet.team, playerIndex: bullet.playerIndex,
        gunSlot: bullet.gunSlot, steelPower: bullet.steelPower,
        tankTeam: tank.team, targetPlayerIndex: tank.playerIndex });
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
    context.events.push({ type: 'explosion', owner: 'player', playerIndex: tank.playerIndex, enemyKind: null });
  } else {
    if (tank.carryingPowerUp) {
      tank.carryingPowerUp = false;
      dropPowerUp(context);
    }
    tank.hp--;
    if (tank.hp === 0) destroyEnemy(context, tank, bullet.playerIndex);
    else context.events.push({ type: 'hit', target: 'tank', team: bullet.team, playerIndex: bullet.playerIndex,
      gunSlot: bullet.gunSlot, steelPower: bullet.steelPower,
      tankTeam: tank.team, targetPlayerIndex: null, enemyKind: tank.kind });
  }
}

function hitTerrain(context: CoreContext, bullet: Bullet): void {
  const state = context.state;
  const materials = new Set<'brick' | 'steel' | 'boundary'>();
  const indexAt = (x: number, y: number) => x < 0 || y < 0 || x >= ARENA_SIZE || y >= ARENA_SIZE
    ? -1 : Math.floor(y / TILE_SIZE) * GRID_SIZE + Math.floor(x / TILE_SIZE);
  // E693 selects one 8px cell. E69A can then change its 4px quadrant
  // without selecting another cell: the extra side probes reuse that pointer.
  const probe = (x: number, y: number, index = indexAt(x, y)): boolean => {
    if (index === -1) {
      bullet.impactTicks = 9;
      materials.add('boundary');
      return false;
    }
    const cellX = (index % GRID_SIZE) * TILE_SIZE;
    const cellY = Math.floor(index / GRID_SIZE) * TILE_SIZE;
    if (state.baseAlive && cellX >= BASE_RECT.x && cellX < BASE_RECT.x + BASE_RECT.width &&
      cellY >= BASE_RECT.y && cellY < BASE_RECT.y + BASE_RECT.height) {
      state.baseAlive = false;
      bullet.impactTicks = 9;
      effect(context, BASE_RECT.x, BASE_RECT.y, undefined, 'base');
      context.events.push({ type: 'explosion', owner: 'base', playerIndex: null, enemyKind: null });
      return false;
    }
    const tile = state.tiles[index];
    const mask = 1 << ((y & 4 ? 2 : 0) + (x & 4 ? 1 : 0));
    if (tile !== Tile.Steel && (tile !== Tile.Brick || !(state.brickMasks[index]! & mask))) return false;
    bullet.impactTicks = 9;
    materials.add(tile === Tile.Steel ? 'steel' : 'brick');
    if (bullet.steelPower) {
      state.tiles[index] = Tile.Empty;
      state.brickMasks[index] = 0;
      // Triple-star hits return zero, so they do not run the extra same-cell probe.
      return false;
    }
    if (tile === Tile.Steel) return false;
    state.brickMasks[index] = state.brickMasks[index]! & ~mask;
    if (state.brickMasks[index] === 0) state.tiles[index] = Tile.Empty;
    return true;
  };
  const vertical = bullet.direction === 'up' || bullet.direction === 'down';
  const sideX = vertical ? 1 : 0, sideY = vertical ? 0 : 1;
  const firstIndex = indexAt(bullet.x, bullet.y);
  if (probe(bullet.x, bullet.y, firstIndex)) {
    probe(bullet.x + sideX * 4, bullet.y + sideY * 4, firstIndex);
  }
  const secondX = bullet.x - sideX, secondY = bullet.y - sideY;
  const secondIndex = indexAt(secondX, secondY);
  if (probe(secondX, secondY, secondIndex)) {
    probe(bullet.x - sideX * 5, bullet.y - sideY * 5, secondIndex);
  }
  for (const material of materials) {
    context.events.push({ type: 'hit', target: material, team: bullet.team, playerIndex: bullet.playerIndex,
      gunSlot: bullet.gunSlot, steelPower: bullet.steelPower });
  }
}

/** E02E moves only the shots that existed before this frame's firing phase. */
export function advanceBullets(context: CoreContext): void {
  const state = context.state;
  for (const bullet of state.bullets) {
    if (bullet.impactTicks) bullet.impactTicks--;
  }
  state.bullets = state.bullets.filter(bullet => bullet.impactTicks !== 0);
  for (const bullet of state.bullets) {
    if (bullet.impactTicks) continue;
    const [dx, dy] = VECTORS[bullet.direction];
    // Movement is every frame; ordinary terrain checks alone are staggered.
    bullet.x += dx * bullet.speed;
    bullet.y += dy * bullet.speed;
  }
}

/** Terrain, opposing shots, enemy shots, enemy tanks, then friendly tanks. */
export function resolveBulletHits(context: CoreContext): void {
  const state = context.state;
  const ordered = [...state.bullets].sort((a, b) => b.gunSlot - a.gunSlot);
  const vanished = new Set<number>();
  const active = (bullet: Bullet) => !bullet.impactTicks && !vanished.has(bullet.id);
  const players = ordered.filter(bullet => bullet.gunSlot < 2 || bullet.gunSlot >= 8);
  const enemies = ordered.filter(bullet => bullet.gunSlot >= 2 && bullet.gunSlot < 8);
  for (const bullet of ordered) {
    if (!active(bullet) || (bullet.speed === 2 && !bullet.steelPower &&
      ((bullet.gunSlot ^ state.tick) & 1) === 0)) continue;
    hitTerrain(context, bullet);
  }
  // E910 scans player guns 9,8,1,0 against every other gun, including the
  // other player. Primary/secondary of the same player never cancel each other.
  for (const bullet of players) {
    if (!active(bullet)) continue;
    for (const other of ordered) {
      if (!active(other) || (other.gunSlot & 7) === (bullet.gunSlot & 7)) continue;
      if (Math.abs(other.x - bullet.x) < 6 && Math.abs(other.y - bullet.y) < 6) {
        vanished.add(bullet.id);
        vanished.add(other.id);
      }
    }
  }
  const contact = (tank: Tank, bullet: Bullet) => tank.spawnTicks === 0 &&
    Math.abs(tank.x + 8 - bullet.x) < 10 && Math.abs(tank.y + 8 - bullet.y) < 10;
  const playerTanks = state.tanks.filter(tank => tank.team === 'player')
    .sort((a, b) => b.playerIndex! - a.playerIndex!);
  const enemyTanks = state.tanks.filter(tank => tank.team === 'enemy')
    .sort((a, b) => b.enemySlot! - a.enemySlot!);
  const hit = (tank: Tank, bullet: Bullet) => {
    if (tank.shieldTicks > 0) vanished.add(bullet.id);
    else bullet.impactTicks = 9;
    hitTank(context, tank, bullet);
  };
  for (const tank of playerTanks) {
    for (const bullet of enemies) {
      if (active(bullet) && contact(tank, bullet)) {
        hit(tank, bullet);
        if (!state.tanks.includes(tank)) break;
      }
    }
  }
  for (const tank of enemyTanks) {
    for (const bullet of players) {
      if (active(bullet) && contact(tank, bullet)) {
        hit(tank, bullet);
        if (!state.tanks.includes(tank)) break;
      }
    }
  }
  for (const tank of playerTanks) {
    if (!state.tanks.includes(tank)) continue;
    for (const bullet of players) {
      if (active(bullet) && (bullet.gunSlot & 1) !== tank.playerIndex && contact(tank, bullet)) {
        const wasStunned = tank.stunTicks > 0;
        hit(tank, bullet);
        // E8AE stops after applying a fresh friendly stun.
        if (tank.shieldTicks === 0 && !wasStunned) break;
      }
    }
  }
  state.bullets = state.bullets.filter(bullet => !vanished.has(bullet.id));
}

/** Combined step for a standalone combat fixture with no intervening fire. */
export function updateBullets(context: CoreContext): void {
  advanceBullets(context);
  resolveBulletHits(context);
}

export function updateEffects(context: CoreContext): void {
  for (const item of context.state.effects) item.remainingTicks--;
  context.state.effects = context.state.effects.filter(item => item.remainingTicks > 0);
}
