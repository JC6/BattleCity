import { TANK_SIZE } from './constants';
import type { Direction } from './types';

export interface Rect { x: number; y: number; width: number; height: number }
export const VECTORS: Readonly<Record<Direction, readonly [number, number]>> = {
  up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0],
};
export const DIRECTIONS: readonly Direction[] = ['up', 'right', 'down', 'left'];

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

export function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

export function tankRect(tank: { x: number; y: number }): Rect {
  return { x: tank.x, y: tank.y, width: TANK_SIZE, height: TANK_SIZE };
}

export function opposite(direction: Direction): Direction {
  return DIRECTIONS[(DIRECTIONS.indexOf(direction) + 2) % 4]!;
}

export function perpendicular(a: Direction, b: Direction): boolean {
  return (VECTORS[a][0] === 0) !== (VECTORS[b][0] === 0);
}
