import { BoxGeometry } from 'three';

/**
 * A box whose UVs are scaled to WORLD size, so one texture tiles across every
 * solid in the course at the same physical scale.
 *
 * This is what lets the whole floor - a hundred-odd slabs of wildly different
 * lengths - be merged into a single mesh with a single material and still have
 * studs the same size everywhere. Without it, a 190-unit runway and a 9-unit
 * island would each stretch one copy of the texture over themselves and the
 * ground would visibly change scale at every seam.
 *
 * `BoxGeometry` lays its 24 vertices out face by face in a fixed order -
 * +X, -X, +Y, -Y, +Z, -Z - and each face's UVs run 0..1. Rewriting them per
 * face with the two dimensions that face actually spans is the whole trick.
 *
 * @param tile world units one repeat of the texture covers
 */
export const texturedBox = (
  width: number,
  height: number,
  depth: number,
  tile: number,
): BoxGeometry => {
  const geometry = new BoxGeometry(width, height, depth);
  const uv = geometry.getAttribute('uv');

  // Per face: how many repeats across, and how many down.
  const spans: readonly (readonly [number, number])[] = [
    [depth / tile, height / tile], // +X
    [depth / tile, height / tile], // -X
    [width / tile, depth / tile], // +Y
    [width / tile, depth / tile], // -Y
    [width / tile, height / tile], // +Z
    [width / tile, height / tile], // -Z
  ];

  for (let face = 0; face < 6; face += 1) {
    const span = spans[face] as readonly [number, number];
    for (let corner = 0; corner < 4; corner += 1) {
      const index = face * 4 + corner;
      uv.setXY(index, uv.getX(index) * span[0], uv.getY(index) * span[1]);
    }
  }
  uv.needsUpdate = true;
  return geometry;
};
