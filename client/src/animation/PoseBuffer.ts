import { BONE_COUNT, BONE_INDEX, type BoneName } from './rig/boneNames.js';

/** A per-bone rotation offset from the bind pose, in radians. */
export interface BoneRotation {
  /** Pitch: positive swings the bone backward (about the character's right axis). */
  x?: number;
  /** Yaw: rotation about the character's up axis. */
  y?: number;
  /** Roll: rotation about the character's forward axis. */
  z?: number;
}

/** A named, static pose. Bones left out are held at their bind rotation. */
export type PoseDefinition = Partial<Record<BoneName, BoneRotation>>;

/**
 * A complete character pose in a flat, allocation-free buffer.
 *
 * Every pose generator writes into one of these and every blend is a plain
 * lerp over the array, so no quaternions are accumulated frame to frame and
 * the pose pipeline cannot drift.
 */
export class PoseBuffer {
  /** [x,y,z] radians per bone, indexed by BONE_INDEX. */
  readonly rotations = new Float32Array(BONE_COUNT * 3);

  /** Vertical bob applied to the VISUAL node only, never to physics position. */
  bobY = 0;

  /** Reset every bone to its bind rotation. */
  reset(): void {
    this.rotations.fill(0);
    this.bobY = 0;
  }

  set(bone: BoneName, x: number, y = 0, z = 0): void {
    const at = BONE_INDEX[bone] * 3;
    this.rotations[at] = x;
    this.rotations[at + 1] = y;
    this.rotations[at + 2] = z;
  }

  add(bone: BoneName, x: number, y = 0, z = 0): void {
    const at = BONE_INDEX[bone] * 3;
    this.rotations[at] = (this.rotations[at] ?? 0) + x;
    this.rotations[at + 1] = (this.rotations[at + 1] ?? 0) + y;
    this.rotations[at + 2] = (this.rotations[at + 2] ?? 0) + z;
  }

  copyFrom(other: PoseBuffer): void {
    this.rotations.set(other.rotations);
    this.bobY = other.bobY;
  }

  /** this = lerp(from, to, t). Writes in place; allocates nothing. */
  lerpBetween(from: PoseBuffer, to: PoseBuffer, t: number): void {
    const a = from.rotations;
    const b = to.rotations;
    const out = this.rotations;
    for (let i = 0; i < out.length; i += 1) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      out[i] = av + (bv - av) * t;
    }
    this.bobY = from.bobY + (to.bobY - from.bobY) * t;
  }

  /** Write a static pose definition into this buffer, clearing everything else. */
  applyDefinition(definition: PoseDefinition, weight = 1): void {
    this.reset();
    this.blendInDefinition(definition, weight);
  }

  /** Add a static pose definition on top of whatever is already here. */
  blendInDefinition(definition: PoseDefinition, weight = 1): void {
    for (const [bone, rotation] of Object.entries(definition) as Array<
      [BoneName, BoneRotation]
    >) {
      this.add(
        bone,
        (rotation.x ?? 0) * weight,
        (rotation.y ?? 0) * weight,
        (rotation.z ?? 0) * weight,
      );
    }
  }
}
