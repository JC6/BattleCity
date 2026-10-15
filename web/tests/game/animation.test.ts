import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { TankAnimation } from '../../src/game/animation';
import { BULLET, DESTROYED_BASE, ENEMY_TANK_FRAMES, EXPLOSION_FRAMES, IMPACT_FRAMES, PALETTE, PLAYER_TANK_FRAMES, POWER_UP_BITMAPS, SPAWN_FRAMES, tankBitmap, tankColors } from '../../src/game/pixel-assets';

function fixture() {
  const state = new GameEngine(getLevel(1), { stage: 1, mode: 'single', seed: 1 }).state;
  state.phase = 'playing';
  const tank = state.tanks[0]; tank.spawnTicks = 0;
  return { state, tank };
}

describe('simulation-driven tank presentation', () => {
  it('changes treads only after actual travel and holds the frame on idle, repeated render and pause', () => {
    const { state, tank } = fixture();
    const animation = new TankAnimation();
    animation.observe(state);
    tank.moving = true; tank.y -= 1; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(0);
    tank.y -= 1; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
    animation.observe(state); animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
    tank.moving = false; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
    state.phase = 'paused'; tank.y -= 5; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
    animation.reset(); expect(animation.frame(tank)).toBe(0);
  });
  it('tracks every simulation step independent of how often frames are rendered', () => {
    const { state, tank } = fixture();
    const a = new TankAnimation(), b = new TankAnimation();
    a.observe(state); b.observe(state);
    for (let tick = 1; tick <= 19; tick++) {
      state.tick = tick; tank.moving = tick % 4 !== 2;
      if (tank.moving) tank.y--;
      a.observe(state); b.observe(state);
      a.frame(tank); a.frame(tank); // A high render rate cannot advance phases.
    }
    expect(a.frame(tank)).toBe(b.frame(tank));
  });
  it('does not count turn alignment as additional tread travel', () => {
    const { state, tank } = fixture();
    const animation = new TankAnimation();
    tank.x = 5; tank.y = 5; animation.observe(state);
    tank.direction = 'up'; tank.moving = true;
    tank.x = 8; tank.y = 7; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(0);
    tank.y--; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
  });
  it('restarts removed tank IDs and rewound ticks while preserving surviving tracks', () => {
    const { state, tank } = fixture();
    const survivor = { ...tank, id: tank.id + 1 };
    state.tanks.push(survivor);
    const animation = new TankAnimation();
    animation.observe(state);
    for (let step = 0; step < 2; step++) {
      tank.moving = survivor.moving = true; tank.y--; survivor.y--; state.tick++;
      animation.observe(state);
    }
    expect(animation.frame(tank)).toBe(1);
    expect(animation.frame(survivor)).toBe(1);

    state.tanks = [survivor]; survivor.moving = false; state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(0);
    expect(animation.frame(survivor)).toBe(1);
    tank.x += 100; tank.y += 100; state.tanks.push(tank); state.tick++; animation.observe(state);
    expect(animation.frame(tank)).toBe(0);
    expect(animation.frame(survivor)).toBe(1);
    tank.y--; state.tick++; animation.observe(state); expect(animation.frame(tank)).toBe(0);
    tank.y--; state.tick++; animation.observe(state); expect(animation.frame(tank)).toBe(1);

    state.phase = 'paused'; state.tick = 0; tank.x += 100; animation.observe(state);
    expect(animation.frame(tank)).toBe(1);
    expect(animation.frame(survivor)).toBe(1);
    state.phase = 'playing'; animation.observe(state);
    expect(animation.frame(tank)).toBe(0);
    expect(animation.frame(survivor)).toBe(0);
    tank.y--; state.tick++; animation.observe(state); expect(animation.frame(tank)).toBe(0);
    tank.y--; state.tick++; animation.observe(state); expect(animation.frame(tank)).toBe(1);
  });
  it('selects distinct star silhouettes and directional frames while using green for 2P', () => {
    const { tank } = fixture();
    const shapes = [0, 1, 2, 3].map(stars => { tank.stars = stars; return tankBitmap(tank, 0).join(''); });
    expect(new Set(shapes).size).toBe(4);
    tank.stars = 3;
    const up = tankBitmap(tank, 0); tank.direction = 'right';
    expect(tankBitmap(tank, 0)).not.toEqual(up);
    tank.playerIndex = 1;
    expect(tankColors(tank, 0).Y).toBe(PALETTE.green);
  });
  it('shows remaining armor health with bonus flashes taking precedence', () => {
    const { tank } = fixture(); tank.team = 'enemy'; tank.playerIndex = null; tank.kind = 'armor';
    const colors = [4, 3, 2, 1].map(hp => { tank.hp = hp; return tankColors(tank, 12); });
    expect(new Set(colors.map(color => JSON.stringify(color))).size).toBe(4);
    tank.carryingPowerUp = true;
    expect(tankColors(tank, 0).W).toBe(PALETTE.red);
    expect(tankColors(tank, 12).W).toBe(PALETTE.white);
  });
  it('keeps every authored bitmap rectangular on its native pixel grid', () => {
    const images = [BULLET, DESTROYED_BASE, ...PLAYER_TANK_FRAMES.flat(), ...Object.values(ENEMY_TANK_FRAMES).flat(),
      ...SPAWN_FRAMES, ...IMPACT_FRAMES, ...EXPLOSION_FRAMES, ...Object.values(POWER_UP_BITMAPS)];
    for (const image of images) {
      expect(image.every(row => row.length === image[0].length), JSON.stringify(image)).toBe(true);
      expect(image.length).toBe(image[0].length);
    }
    expect(Object.values(POWER_UP_BITMAPS).every(image => image.length === 16)).toBe(true);
  });
});
