import { Bone, Object3D, SkinnedMesh, Quaternion, Vector3 } from 'three';
import { logger } from '../../util/logger.js';
import type { PoseBuffer } from '../PoseBuffer.js';
import { BONE_INDEX, BONE_NAMES, type BoneName } from './boneNames.js';

const SCOPE = 'PlayerRig';

const CHARACTER_RIGHT = new Vector3(1, 0, 0);
const CHARACTER_UP = new Vector3(0, 1, 0);
const CHARACTER_FORWARD = new Vector3(0, 0, 1);

/** Below this magnitude a bone is left at its bind rotation. */
const EPSILON = 1e-5;

interface BoneBinding {
  bone: Bone;
  /** The bone's local rotation in the FBX bind pose. All poses offset from this. */
  restQuaternion: Quaternion;
  /**
   * The character-space X/Y/Z axes expressed in this bone's PARENT space.
   *
   * player.fbx bakes non-trivial orientations into the rig (LegL1 is authored
   * at 180/90/0, ArmL2 at 0/-104/0, and the whole armature carries a -90 X
   * export correction), so a bone's local axes do not line up with the
   * character's. Resolving the axes once at bind time lets every pose be
   * authored in intuitive character-space terms - "swing the thigh forward" -
   * instead of per-bone magic numbers.
   */
  axisX: Vector3;
  axisY: Vector3;
  axisZ: Vector3;
}

/**
 * Binds the 12 named bones of one cloned player model and applies poses to them.
 *
 * This is the only place that touches `Bone.quaternion`. Every write is
 * `rotation * restQuaternion`, rebuilt from scratch each frame, so repeated
 * posing can never accumulate quaternion error.
 */
export class PlayerRig {
  private readonly bindings = new Map<BoneName, BoneBinding>();

  private readonly scratchRotation = new Quaternion();
  private readonly scratchAxisRotation = new Quaternion();

  /** Bone names that could not be found in the model. Empty when healthy. */
  readonly missingBones: BoneName[] = [];

  /**
   * @param model      the cloned FBX instance owning the bones
   * @param reference  node defining "character space"; axes are resolved
   *                   relative to it so the rig is independent of world yaw
   */
  constructor(model: Object3D, reference: Object3D) {
    reference.updateMatrixWorld(true);
    const found = collectDeformingBones(model);

    const referenceWorld = new Quaternion();
    reference.getWorldQuaternion(referenceWorld);
    const referenceWorldInverse = referenceWorld.clone().invert();

    for (const name of BONE_NAMES) {
      const bone = found.get(name);
      if (!bone) {
        this.missingBones.push(name);
        continue;
      }
      this.bindings.set(name, this.createBinding(bone, referenceWorldInverse));
    }

    if (this.missingBones.length > 0) {
      logger.warn(
        SCOPE,
        `rig is missing ${this.missingBones.length} bone(s):`,
        this.missingBones.join(', '),
        '- those bones will simply not animate',
      );
    }
  }

  /** True when every expected bone was bound. */
  get isComplete(): boolean {
    return this.missingBones.length === 0;
  }

  /**
   * The bone bound to a name, for attaching cosmetics.
   *
   * Anything parented to a returned bone follows the animation automatically.
   * Callers must not write to the bone's rotation - that belongs to applyPose.
   */
  getBone(name: BoneName): Bone | null {
    return this.bindings.get(name)?.bone ?? null;
  }

  get boundBoneCount(): number {
    return this.bindings.size;
  }

  /** Write a pose onto the skeleton. Called once per frame. */
  applyPose(pose: PoseBuffer): void {
    const values = pose.rotations;

    for (const [name, binding] of this.bindings) {
      const at = BONE_INDEX[name] * 3;
      const x = values[at] ?? 0;
      const y = values[at + 1] ?? 0;
      const z = values[at + 2] ?? 0;

      if (Math.abs(x) < EPSILON && Math.abs(y) < EPSILON && Math.abs(z) < EPSILON) {
        binding.bone.quaternion.copy(binding.restQuaternion);
        continue;
      }

      const rotation = this.scratchRotation;
      const axisRotation = this.scratchAxisRotation;

      rotation.setFromAxisAngle(binding.axisX, x);
      if (Math.abs(y) >= EPSILON) {
        axisRotation.setFromAxisAngle(binding.axisY, y);
        rotation.premultiply(axisRotation);
      }
      if (Math.abs(z) >= EPSILON) {
        axisRotation.setFromAxisAngle(binding.axisZ, z);
        rotation.premultiply(axisRotation);
      }

      // Rebuilt from the bind pose every frame - never compounded.
      binding.bone.quaternion.copy(rotation).multiply(binding.restQuaternion);
    }
  }

  /** Restore the untouched bind pose. */
  resetToBindPose(): void {
    for (const binding of this.bindings.values()) {
      binding.bone.quaternion.copy(binding.restQuaternion);
    }
  }

  private createBinding(bone: Bone, referenceWorldInverse: Quaternion): BoneBinding {
    // Character-space -> parent-space, so authored poses read the same for
    // every bone regardless of how the FBX baked its orientation.
    const parentWorld = new Quaternion();
    bone.parent?.getWorldQuaternion(parentWorld);

    const parentInCharacterSpace = referenceWorldInverse.clone().multiply(parentWorld);
    const characterToParent = parentInCharacterSpace.invert();

    return {
      bone,
      restQuaternion: bone.quaternion.clone(),
      axisX: CHARACTER_RIGHT.clone().applyQuaternion(characterToParent).normalize(),
      axisY: CHARACTER_UP.clone().applyQuaternion(characterToParent).normalize(),
      axisZ: CHARACTER_FORWARD.clone().applyQuaternion(characterToParent).normalize(),
    };
  }
}

/**
 * Collect the real joint for each bone name.
 *
 * player.fbx carries TWO skin deformers - one for the arms mesh, one for the
 * body mesh - and FBXLoader resolves them to two DIFFERENT sets of Bone
 * objects that share the same twelve names. For every name there is a real
 * joint plus a zero-length terminal bone parented to it, and the two meshes
 * happen to bind to different sets:
 *
 *   Cube010 (arms) -> the terminal bones
 *   Cube011 (body) -> the real joints
 *
 * Posing the real joints drives both meshes, because each terminal is a CHILD
 * of its real joint and inherits its world transform. Posing the terminals
 * instead would move the arms only and silently leave the body in bind pose.
 *
 * Scene-graph traversal always visits a parent before its child, so keeping
 * the FIRST bone seen for each name reliably selects the real joint.
 */
const collectDeformingBones = (model: Object3D): Map<string, Bone> => {
  const found = new Map<string, Bone>();
  model.traverse((child) => {
    if (child instanceof Bone && !found.has(child.name)) found.set(child.name, child);
  });
  return found;
};

/** Names of the bones each SkinnedMesh binds to, for diagnostics. */
export const describeSkinBindings = (model: Object3D): string[] => {
  const lines: string[] = [];
  model.traverse((child) => {
    if (!(child instanceof SkinnedMesh)) return;
    lines.push(`${child.name}: ${child.skeleton.bones.length} bones`);
  });
  return lines;
};
