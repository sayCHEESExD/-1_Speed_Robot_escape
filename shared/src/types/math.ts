/** Plain 3-component vector. Deliberately framework-free. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned box, used for every solid in the course. */
export interface Aabb {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest-path rotation from `current` toward `target`, capped at `maxDelta`. */
export const rotateTowards = (
  current: number,
  target: number,
  maxDelta: number,
): number => {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
};
