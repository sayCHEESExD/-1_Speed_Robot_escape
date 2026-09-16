import type { RobotDefinition, RobotShape } from '@robot/shared';
import { canopyRimY, cockpitFloorY, hipHeightOf, shoulderTopY } from '@robot/shared';
import type { BufferGeometry } from 'three';
import { BoxSet } from './BoxSet.js';

/**
 * ONE generic mech builder, driven entirely by the roster's `shape`, `palette`
 * and `features`.
 *
 * There is deliberately no per-frame modelling code: a scout walker and a
 * siege platform are the same three dozen boxes at different sizes with
 * different hardware bolted on. That is what makes a thirteenth mech a data
 * entry rather than a renderer change - and it is why every machine in the
 * game looks like it came out of the same factory.
 *
 * ================= THE COCKPIT IS THE WHOLE DESIGN =================
 *
 * The chest is built as a SHELL, not a block: a back wall, two side walls, a
 * floor and a low front dash, with a hollow between them that the pilot stands
 * in. Their legs and waist are inside the machine, their head and shoulders
 * are above the canopy rim, and a brow and two A-pillars frame them.
 *
 * The previous version of this file built the chest as one solid box and
 * parked the pilot on a collar ON TOP of it, which read as a person standing
 * on a small robot's head - the exact opposite of the thing this game is
 * about. If a change here ever puts a solid slab across the cockpit opening,
 * or moves the rider anchor above `canopyRimY`, that bug is back.
 *
 * Coordinates are MECH SPACE: origin on the GROUND between the feet, +Y up,
 * +Z forward (the way the machine faces). Each returned geometry is expressed
 * in its own JOINT's local space, hanging DOWN the -Y axis from that joint, so
 * it can be rotated straight onto an animated node with no offset of its own.
 */

/**
 * Geometry and joint offsets for one mech.
 *
 * Built once and shared by every instance of that frame in the scene, which is
 * what makes a ten-bay hangar four dozen meshes rather than five hundred.
 *
 * The limbs are TWO SEGMENTS EACH, and that is not decoration: a knee that
 * actually folds is the difference between a machine that walks and one whose
 * legs pivot like scissors.
 */
export interface RobotParts {
  /**
   * Hull, cockpit shell, shoulders and every piece of hardware on them.
   *
   * Origin at the BODY node, which sits at the HIP LINE: the chest rises from
   * there and the legs hang from it, so pitching the body about X leans the
   * whole upper half without moving the feet.
   */
  readonly body: BufferGeometry;
  /** Upper arms, origin at the shoulder. Two, because the shield is left-only. */
  readonly upperArmL: BufferGeometry;
  readonly upperArmR: BufferGeometry;
  /** Forearm and fist, origin at the elbow. Shared by both arms. */
  readonly forearm: BufferGeometry;
  /** Thigh, origin at the hip. Shared by both legs. */
  readonly thigh: BufferGeometry;
  /** Shin, ankle and foot, origin at the knee. Shared by both legs. */
  readonly shin: BufferGeometry;
  /**
   * The lit parts: canopy strip, reactor, vents, thruster bells.
   *
   * Split out so they can carry an emissive material while the armour stays
   * ordinary Lambert - a machine whose neon is merely a bright vertex colour
   * reads as painted, and emissive on the whole model would flatten the plates
   * into a slab of light.
   */
  readonly glow: BufferGeometry | null;

  /** Where the body node hangs, in MECH space. The hip line. */
  readonly hipY: number;
  /** Shoulder joints, in BODY-node local space. Left is +X. */
  readonly shoulder: readonly [number, number, number];
  /** Hip joints, in BODY-node local space. Left is +X. */
  readonly hip: readonly [number, number, number];
  /** Elbow, below the shoulder joint. */
  readonly elbowY: number;
  /** Knee, below the hip joint. */
  readonly kneeY: number;
  /** The cockpit floor, in BODY-node local space. Where the pilot stands. */
  readonly cockpitY: number;
  /** Height of the whole machine, pilot excluded. For labels and framing. */
  readonly height: number;
}

/** Cache keyed by mech id. Twelve frames, built once each, shared forever. */
const CACHE = new Map<string, RobotParts>();

/** Geometry for one mech, built on first use. */
export const robotParts = (definition: RobotDefinition): RobotParts => {
  const cached = CACHE.get(definition.id);
  if (cached) return cached;
  const built = build(definition);
  CACHE.set(definition.id, built);
  return built;
};

/**
 * Release every cached geometry.
 *
 * Only for a full teardown. Instances share these, so disposing while any mech
 * is still on screen empties it.
 */
export const disposeRobotGeometry = (): void => {
  for (const parts of CACHE.values()) {
    parts.body.dispose();
    parts.upperArmL.dispose();
    parts.upperArmR.dispose();
    parts.forearm.dispose();
    parts.thigh.dispose();
    parts.shin.dispose();
    parts.glow?.dispose();
  }
  CACHE.clear();
};

/** Build a set, or throw - every part here always has geometry in it. */
const finish = (set: BoxSet, what: string): BufferGeometry => {
  const built = set.build();
  if (!built) throw new Error(`mech ${what} built empty`);
  return built;
};

const build = (definition: RobotDefinition): RobotParts => {
  const shape = definition.shape;
  const palette = definition.palette;
  const features = new Set(definition.features);

  const body = new BoxSet();
  const glow = new BoxSet();

  const hipY = hipHeightOf(shape);
  // Everything below is written in BODY-node space, which sits at the hip
  // line - so the waist starts at 0 and the chest on top of it.
  const chestBase = shape.waistHeight;
  const chestTop = chestBase + shape.torsoHeight;
  const rim = canopyRimY(shape) - hipY;
  const shoulderY = chestTop - shape.shoulderSize * 0.35;

  const halfW = shape.torsoWidth / 2;
  const halfD = shape.torsoDepth / 2;
  const bayW = shape.cockpitWidth / 2;
  const bayD = shape.cockpitDepth / 2;

  // ---- Waist and hips ----------------------------------------------------
  body.add(
    [shape.waistWidth, shape.waistHeight, shape.torsoDepth * 0.8],
    [0, shape.waistHeight / 2, 0],
    palette.frame,
  );
  body.addMirrored(
    [shape.legThickness * 1.3, shape.waistHeight * 1.1, shape.legThickness * 1.3],
    [shape.hipSpread, shape.waistHeight * 0.25, 0],
    palette.armorDark,
  );

  /*
   * ================== THE COCKPIT SHELL ==================
   *
   * Five plates around a hollow. Every one of them is placed relative to the
   * bay rather than to the chest, so widening the cockpit moves the armour out
   * of the pilot's way instead of through them.
   */

  // Back wall: the full width of the chest, behind the pilot.
  body.add(
    [shape.torsoWidth, shape.torsoHeight, halfD - bayD],
    [0, chestBase + shape.torsoHeight / 2, -(bayD + (halfD - bayD) / 2)],
    palette.armor,
  );
  // Side walls: from the bay out to the shell, full height.
  body.addMirrored(
    [halfW - bayW, shape.torsoHeight, shape.torsoDepth],
    [bayW + (halfW - bayW) / 2, chestBase + shape.torsoHeight / 2, 0],
    palette.armor,
  );
  // Cockpit floor: the plate the pilot stands on.
  body.add(
    [shape.cockpitWidth, 0.3, shape.cockpitDepth * 2],
    [0, chestBase + 0.15, 0],
    palette.frame,
  );
  // The dash: a low front plate the pilot's knees are behind, which is what
  // stops the bay reading as a hole punched through the chest.
  body.add(
    [shape.cockpitWidth, shape.torsoHeight * 0.34, halfD - bayD],
    [0, chestBase + shape.torsoHeight * 0.17, bayD + (halfD - bayD) / 2],
    palette.armorDark,
  );
  glow.add(
    [shape.cockpitWidth * 0.72, 0.16, 0.18],
    [0, chestBase + shape.torsoHeight * 0.34 + 0.08, bayD + 0.1],
    palette.glow,
  );

  /*
   * THE CANOPY: a brow across the front and an A-pillar down each side.
   *
   * Open on purpose. A closed canopy would hide the one thing the player has
   * bought twelve of these to look at, and a bay with no frame at all reads as
   * damage rather than as a hatch.
   */
  body.add(
    [shape.cockpitWidth + 0.5, 0.36, halfD - bayD + 0.3],
    [0, rim + 0.18, bayD * 0.7],
    palette.trim,
  );
  body.addMirrored(
    [0.3, shape.torsoHeight - shape.canopyDrop, 0.34],
    [bayW + 0.12, chestBase + (rim - chestBase) / 2, bayD + 0.1],
    palette.trim,
  );
  glow.add(
    [shape.cockpitWidth * 0.55, 0.14, 0.14],
    [0, rim + 0.02, bayD + 0.22],
    palette.glow,
  );

  // Shoulder yoke across the top of the chest, behind the pilot.
  body.add(
    [shape.torsoWidth * 0.92, 0.42, halfD * 0.9],
    [0, chestTop + 0.21, -halfD * 0.42],
    palette.armorDark,
  );

  // ---- Shoulders ---------------------------------------------------------
  body.addMirrored(
    [shape.shoulderSize * 1.15, shape.shoulderSize, shape.shoulderSize * 1.2],
    [shape.shoulderSpread, shoulderY, 0],
    palette.armor,
  );
  body.addMirrored(
    [shape.shoulderSize * 1.25, shape.shoulderSize * 0.24, shape.shoulderSize * 1.3],
    [shape.shoulderSpread, shoulderY + shape.shoulderSize * 0.58, 0],
    palette.armorDark,
  );
  // The lit shoulder blade - the running light every machine in the facility
  // carries, and the thing that says which way a mech is facing in the dark.
  glow.addMirrored(
    [0.2, shape.shoulderSize * 0.5, shape.shoulderSize * 0.9],
    [shape.shoulderSpread + shape.shoulderSize * 0.6, shoulderY, 0],
    palette.glow,
  );

  // ---- Hardware ----------------------------------------------------------
  if (features.has('reactor')) {
    // Under the bay, on the belly plate: a core the pilot is sitting over.
    glow.add(
      [shape.cockpitWidth * 0.5, 0.5, 0.22],
      [0, chestBase + shape.torsoHeight * 0.1, halfD + 0.02],
      palette.glow,
    );
  }

  if (features.has('crest')) {
    for (const side of [-1, 1]) {
      body.add(
        [0.22, shape.shoulderSize * 0.85, 0.22],
        [side * shape.cockpitWidth * 0.32, rim + shape.shoulderSize * 0.5, bayD * 0.9],
        palette.trim,
        [0.3, 0, side * 0.42],
      );
    }
  }

  if (features.has('antenna')) {
    body.addMirrored(
      [0.16, shape.shoulderSize * 1.6, 0.16],
      [
        shape.shoulderSpread * 1.02,
        shoulderY + shape.shoulderSize * 1.3,
        -shape.shoulderSize * 0.3,
      ],
      palette.frame,
    );
    glow.addMirrored(
      [0.24, 0.24, 0.24],
      [
        shape.shoulderSpread * 1.02,
        shoulderY + shape.shoulderSize * 2.15,
        -shape.shoulderSize * 0.3,
      ],
      palette.glow,
    );
  }

  if (features.has('backpack')) {
    body.add(
      [shape.torsoWidth * 0.78, shape.torsoHeight * 0.8, shape.torsoDepth * 0.45],
      [0, chestBase + shape.torsoHeight * 0.55, -(halfD + shape.torsoDepth * 0.22)],
      palette.armorDark,
    );
    for (let i = 0; i < 3; i += 1) {
      glow.add(
        [shape.torsoWidth * 0.56, 0.12, 0.1],
        [
          0,
          chestBase + shape.torsoHeight * (0.82 - i * 0.24),
          -(halfD + shape.torsoDepth * 0.45),
        ],
        palette.glow,
      );
    }
  }

  if (features.has('thrusters')) {
    body.addMirrored(
      [shape.torsoWidth * 0.24, shape.torsoHeight * 0.6, shape.torsoDepth * 0.3],
      [shape.torsoWidth * 0.3, chestBase + shape.torsoHeight * 0.45, -(halfD + 0.3)],
      palette.frame,
    );
    glow.addMirrored(
      [shape.torsoWidth * 0.18, shape.torsoWidth * 0.18, 0.16],
      [shape.torsoWidth * 0.3, chestBase + shape.torsoHeight * 0.2, -(halfD + 0.5)],
      palette.glow,
    );
  }

  if (features.has('binders')) {
    for (const side of [-1, 1]) {
      body.add(
        [0.3, shape.shoulderSize * 2.1, shape.shoulderSize * 0.8],
        [
          side * shape.shoulderSpread * 1.12,
          shoulderY + shape.shoulderSize * 0.2,
          -halfD * 0.7,
        ],
        palette.armor,
        [0.22, 0, side * 0.2],
      );
      glow.add(
        [0.16, shape.shoulderSize * 1.6, 0.12],
        [
          side * shape.shoulderSpread * 1.26,
          shoulderY + shape.shoulderSize * 0.2,
          -halfD * 0.7,
        ],
        palette.glow,
        [0.22, 0, side * 0.2],
      );
    }
  }

  if (features.has('cannon')) {
    // RIGHT shoulder, because the shield goes on the left - a machine carrying
    // both on one side reads as damaged rather than as armed. Right is -X, the
    // same convention the whole world layout uses.
    body.add(
      [shape.shoulderSize * 0.46, shape.shoulderSize * 0.46, shape.shoulderSize * 2.4],
      [-shape.shoulderSpread, shoulderY + shape.shoulderSize * 0.85, shape.shoulderSize * 0.3],
      palette.frame,
    );
    glow.add(
      [shape.shoulderSize * 0.22, shape.shoulderSize * 0.22, 0.18],
      [-shape.shoulderSpread, shoulderY + shape.shoulderSize * 0.85, shape.shoulderSize * 1.55],
      palette.glow,
    );
  }

  if (features.has('halo')) {
    const radius = shape.shoulderSpread * 1.1;
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      glow.add(
        [shape.shoulderSize * 0.5, 0.12, 0.18],
        [
          Math.cos(angle) * radius,
          chestTop + shape.shoulderSize * 1.4,
          Math.sin(angle) * radius,
        ],
        palette.glow,
        [0, -angle, 0],
      );
    }
  }

  // ---- Arms --------------------------------------------------------------
  const t = shape.armThickness;

  const upperArm = (withShield: boolean): BufferGeometry => {
    const set = new BoxSet();
    set.add([t, shape.upperArmLength, t], [0, -shape.upperArmLength / 2, 0], palette.armor);
    set.add([t * 1.18, t * 0.5, t * 1.18], [0, -shape.upperArmLength, 0], palette.frame);
    if (withShield) {
      set.add(
        [t * 0.4, shape.upperArmLength * 2.1, shape.forearmLength * 1.6],
        [t * 1.0, -shape.upperArmLength * 1.0, 0],
        palette.trim,
      );
    }
    return finish(set, 'upper arm');
  };

  const forearm = (): BufferGeometry => {
    const set = new BoxSet();
    // Thicker than the upper arm: mecha arms are bottom-heavy.
    set.add(
      [t * 1.22, shape.forearmLength, t * 1.22],
      [0, -shape.forearmLength / 2, 0],
      palette.armor,
    );
    set.add(
      [t * 1.34, t * 0.9, t * 1.34],
      [0, -shape.forearmLength - t * 0.4, 0],
      palette.armorDark,
    );
    return finish(set, 'forearm');
  };

  // ---- Legs --------------------------------------------------------------
  const lt = shape.legThickness;

  const thigh = (): BufferGeometry => {
    const set = new BoxSet();
    set.add([lt, shape.thighLength, lt], [0, -shape.thighLength / 2, 0], palette.armor);
    /*
     * THE KNEE, AND IT IS DEEPER THAN THE SHIN ON PURPOSE.
     *
     * The shin hangs from this block and its armour is `lt * 1.12` deep. A
     * knee the same depth put two same-facing surfaces on exactly the same
     * plane, and a depth buffer cannot choose between them: the joint tore
     * into the hatched flicker that coplanar faces always produce, on every
     * mech in the roster, from every angle. The elbow avoided it by accident -
     * its block is 1.18 against a 1.22 forearm - and this is that same
     * clearance made deliberate.
     *
     * A joint standing PROUD of the limb below it is also simply what a
     * mechanical knee looks like, so the fix costs nothing visually.
     */
    set.add([lt * 1.12, lt * 0.55, lt * 1.24], [0, -shape.thighLength, 0], palette.frame);
    return finish(set, 'thigh');
  };

  const shin = (): BufferGeometry => {
    const set = new BoxSet();
    if (features.has('greaves')) {
      set.add([lt * 1.3, lt * 0.85, lt * 0.45], [0, -lt * 0.12, lt * 0.74], palette.trim);
    }
    set.add(
      [lt * 1.06, shape.shinLength, lt * 1.12],
      [0, -shape.shinLength / 2, 0],
      palette.armor,
    );
    set.add(
      [lt * 0.82, shape.footHeight * 0.7, lt * 0.82],
      [0, -shape.shinLength - shape.footHeight * 0.35, 0],
      palette.frame,
    );
    // The foot: long, so the frame reads as something that could actually
    // stand up under its own weight.
    set.add(
      [lt * 1.34, shape.footHeight, shape.footLength],
      [0, -shape.shinLength - shape.footHeight / 2, shape.footLength * 0.18],
      palette.armorDark,
    );
    return finish(set, 'shin');
  };

  return {
    body: finish(body, 'body'),
    // The player's LEFT is +X in this game, and the shield goes on it.
    upperArmL: upperArm(features.has('shield')),
    upperArmR: upperArm(false),
    forearm: forearm(),
    thigh: thigh(),
    shin: shin(),
    glow: glow.build(),
    hipY,
    shoulder: [shape.shoulderSpread, shoulderY, 0],
    hip: [shape.hipSpread, 0, 0],
    elbowY: -shape.upperArmLength,
    kneeY: -shape.thighLength,
    cockpitY: cockpitFloorY(shape) - hipY,
    height: shoulderTopY(shape),
  };
};

/** Re-exported so the renderer can frame a display model without the maths. */
export type { RobotShape };
