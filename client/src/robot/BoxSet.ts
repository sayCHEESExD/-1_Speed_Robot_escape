import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A pile of coloured boxes that becomes ONE geometry.
 *
 * Every robot in this game is built from boxes, which is what keeps the
 * silhouettes toy-brick and the file size at zero - there is not a single
 * model asset in the build. Merging them into one vertex-coloured geometry per
 * moving part is what keeps that cheap at runtime too: a ten-robot lobby is
 * about seventy meshes sharing one material, not seven hundred.
 *
 * Colours are baked into vertices rather than materials, so the whole roster
 * renders with a SINGLE `MeshLambertMaterial` and no per-robot uploads.
 */
export class BoxSet {
  private readonly parts: BufferGeometry[] = [];

  private readonly scratchMatrix = new Matrix4();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchEuler = new Euler();
  private readonly scratchPos = new Vector3();
  private readonly scratchScale = new Vector3(1, 1, 1);
  private readonly scratchColor = new Color();

  /**
   * Add one box.
   *
   * @param size     width (X), height (Y), depth (Z)
   * @param at       centre, in this part's local space
   * @param colorHex flat colour for every face
   * @param rotation optional Euler rotation, radians
   */
  add(
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    colorHex: number,
    rotation?: readonly [number, number, number],
  ): this {
    const [w, h, d] = size;
    // A degenerate box would contribute NaN normals to the merge, so a feature
    // that resolves to zero size is simply skipped rather than guarded at
    // every call site.
    if (w <= 0 || h <= 0 || d <= 0) return this;

    const geometry = new BoxGeometry(w, h, d);
    // No material here has a map, so the UVs are dead weight - and an
    // attribute set that differs between parts would make the merge fail.
    geometry.deleteAttribute('uv');

    if (rotation) {
      this.scratchEuler.set(rotation[0], rotation[1], rotation[2]);
      this.scratchQuat.setFromEuler(this.scratchEuler);
    } else {
      this.scratchQuat.identity();
    }
    this.scratchPos.set(at[0], at[1], at[2]);
    this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
    geometry.applyMatrix4(this.scratchMatrix);

    // `Color` converts the sRGB hex into the renderer's linear working space,
    // which is what makes a vertex colour match the same hex used on a
    // material elsewhere in the scene.
    this.scratchColor.set(colorHex);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = this.scratchColor.r;
      colors[i * 3 + 1] = this.scratchColor.g;
      colors[i * 3 + 2] = this.scratchColor.b;
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));

    this.parts.push(geometry);
    return this;
  }

  /** Add a box and its mirror image across X. */
  addMirrored(
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    colorHex: number,
    rotation?: readonly [number, number, number],
  ): this {
    this.add(size, at, colorHex, rotation);
    this.add(
      size,
      [-at[0], at[1], at[2]],
      colorHex,
      // Mirroring a rotation means negating the two components that would
      // otherwise swing the copy the same way round instead of the opposite.
      rotation ? [rotation[0], -rotation[1], -rotation[2]] : undefined,
    );
    return this;
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /**
   * Merge everything added so far into one geometry.
   *
   * The source boxes are disposed: they exist only to be merged, and holding
   * them would leak a few hundred small geometries per species.
   */
  build(): BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    merged.computeBoundingSphere();
    return merged;
  }
}
