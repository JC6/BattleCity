import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { BULLET_FRAMES, DESTROYED_BASE, EXPLOSION_FRAMES, IMPACT_FRAMES, PALETTE, POWER_UP_BITMAPS, SPAWN_FRAMES, tankBitmap, tankColors } from '../../src/game/pixel-assets';

function fixture() {
  const state = new GameEngine(getLevel(1), { stage: 1, mode: 'single', seed: 1 }).state;
  state.phase = 'playing';
  const tank = state.tanks[0]; tank.spawnTicks = 0;
  return { state, tank };
}

describe('simulation-driven tank presentation', () => {
  it('selects distinct star silhouettes and directional frames while using green for 2P', () => {
    const { tank } = fixture();
    const shapes = [0, 1, 2, 3].map(stars => { tank.stars = stars; return tankBitmap(tank, 0).join(''); });
    expect(new Set(shapes).size).toBe(4);
    tank.stars = 3;
    const up = tankBitmap(tank, 0); tank.direction = 'right';
    expect(tankBitmap(tank, 0)).not.toEqual(up);
    tank.playerIndex = 1;
    expect(tankColors(tank, 0).Y).toBe(PALETTE.playerGreen);
  });
  it('shows remaining armor health with bonus flashes taking precedence', () => {
    const { tank } = fixture(); tank.team = 'enemy'; tank.playerIndex = null; tank.kind = 'armor';
    const colors = [4, 3, 2, 1].map(hp => { tank.hp = hp; return tankColors(tank, 12); });
    expect(colors[0]).toEqual({ W: 0xb8f8b8, S: PALETTE.playerGreen, C: PALETTE.playerGreenDark });
    expect(colors[1]).toEqual(colors[2]);
    expect(colors[3].C).toBe(PALETTE.enemyDark);
    tank.carryingPowerUp = true;
    expect(tankColors(tank, 8)).toEqual({ W: PALETTE.white, S: PALETTE.red, C: 0x440064 });
    expect(tankColors(tank, 0).S).toBe(PALETTE.light);
  });
  it('keeps each state bitmap on its native pixel grid', () => {
    const { tank } = fixture();
    const tanks = [0, 1, 2, 3].flatMap(stars => (['up', 'right', 'down', 'left'] as const).flatMap(direction =>
      ([0, 1] as const).map(frame => tankBitmap({ ...tank, stars, direction }, frame))));
    const images = [DESTROYED_BASE, ...tanks,
      ...SPAWN_FRAMES, ...IMPACT_FRAMES, ...EXPLOSION_FRAMES, ...Object.values(POWER_UP_BITMAPS)];
    for (const image of images) {
      expect(image.every(row => row.length === image[0].length), JSON.stringify(image)).toBe(true);
      expect(image.length).toBe(image[0].length);
    }
    for (const image of Object.values(BULLET_FRAMES)) expect([image[0].length, image.length]).toEqual([8, 16]);
    expect(Object.values(POWER_UP_BITMAPS).every(image => image.length === 16)).toBe(true);
  });
});
