import type { PoseDefinition } from '../animation/PoseBuffer.js';

const deg = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Procedural animation tuning.
 *
 * Data-driven on purpose: every number both animators use lives here, so the
 * mount can be re-tuned without touching a line of logic. All rider rotations
 * are in CHARACTER space (see `PlayerRig`); all robot rotations are in the
 * robot's own node space.
 */

/** The walk cycle every mech moves to. */
export const GAIT = {
  /**
   * Cycle frequency clamp, in cycles per second.
   *
   * The upper bound is the single most important number in this file. Phase
   * advances with DISTANCE, so a level-160 mech at four hundred units a second
   * would otherwise take 130 steps a second - a strobe, not a walk. Clamping
   * the cadence means the motion stays readable at any speed and the sense of
   * pace comes from the world going past, which is where it belongs.
   */
  minFrequency: 0.5,
  maxFrequency: 2.3,

  /** Below this speed the mech is standing still. */
  idleSpeed: 0.6,
  /** Speed at which the WALK pose is fully in effect, before the multiplier. */
  walkSpeed: 8,
  /** Speed at which the RUN pose is fully in effect, before the multiplier. */
  runSpeed: 20,

  /**
   * How far the mech leans into a steer, and how quickly it gets there.
   *
   * SMALL, because a mech does not lean. Four degrees is enough to tell a
   * player the machine is turning and far too little to read as a character
   * swaying - which is exactly the distinction this whole file was retuned
   * for. The rate is high so the lean ARRIVES rather than drifting in.
   */
  bankAngle: deg(4),
  bankRate: 12,

  /**
   * KEYFRAMES PER STRIDE.
   *
   * The single number that makes this walk mechanical. The cycle is sampled at
   * this many fixed attitudes and the limbs HOLD at each one, then travel
   * quickly to the next - the way a servo drives a joint between commanded
   * positions. A continuous sine through the same poses is the same motion
   * with all the machinery taken out of it, and that is what made the mech
   * read as a person strolling.
   */
  keyframes: 8,
  /**
   * Fraction of each keyframe interval spent HOLDING before moving.
   *
   * The hold is the mechanical part. At 0 this is an ordinary smooth cycle; at
   * 0.45 the joint sits still for nearly half of every beat and then snaps
   * across, which is what a stepper motor looks like.
   */
  keyframeHold: 0.45,
} as const;

/**
 * WALK: the ground cycle, and the pose it deepens into at a run.
 *
 * One cycle, not two clips. `run` is a blend the whole pose travels toward as
 * the mech speeds up - the stride opens, the arms drive harder, the body
 * leans in and the hips drop further on each footfall - so accelerating reads
 * as a change of gait rather than as the same walk played faster.
 */
export const WALK = {
  /** Hip swing, fore and aft, at a walk and at a full run. */
  thighSwing: { walk: deg(22), run: deg(38) },
  /**
   * How far the knee folds on the BACK half of the stride.
   *
   * A mech knee only ever bends one way, so this is applied as a one-sided
   * term rather than a sine: a leg that bent forward at the knee would be the
   * single most obvious way a walk cycle looks wrong.
   */
  kneeBend: { walk: deg(26), run: deg(46) },
  /** Arm counter-swing. Opposite the leg on the same side, always. */
  armSwing: { walk: deg(16), run: deg(30) },
  /** How far the elbows are held bent while moving. */
  elbowBend: { walk: deg(12), run: deg(26) },

  /**
   * Vertical drop, in world units, on each footfall.
   *
   * TWICE per cycle, because a walker settles on every foot and there are two
   * of those per stride. It is the ONE oscillation the frame is allowed, it is
   * along the machine's own axis, and it reads as weight coming down on a leg
   * rather than as a body swaying.
   */
  bob: { walk: 0.12, run: 0.22 },
  /**
   * Forward lean of the whole frame, standing -> moving.
   *
   * Small. A mech carries its mass over its hips and does not stoop into a
   * run, and an eleven-degree lean was most of why this one looked like a
   * person jogging.
   */
  lean: { idle: deg(0), run: deg(4) },
} as const;

/**
 * AIR: the jump, the fall, and the landing.
 *
 * Three poses and a blend between them. `jump` and `fall` are told apart by
 * the sign of vertical velocity rather than by a state machine, which is what
 * keeps the top of an arc a smooth roll-over instead of a snap.
 */
export const AIR = {
  /** Knees drawn up on the way UP - the coiled launch pose. */
  jumpThigh: deg(-46),
  jumpKnee: deg(58),
  /** Arms thrown out and back as the frame leaves the ground. */
  jumpArm: deg(-52),
  /** Legs reaching for the deck on the way DOWN. */
  fallThigh: deg(16),
  fallKnee: deg(20),
  fallArm: deg(24),
  /** Body pitch while rising and while falling. Negative leans back. */
  risePitch: deg(-8),
  fallPitch: deg(10),
  /** Vertical velocity at which those poses are fully applied. */
  velocityReference: 18,
  /**
   * How quickly the air pose comes in, and how quickly it lets go.
   *
   * FAST, both ways. A mech's legs are driven to a position; they do not ease
   * into one. A slow blend here is what turns a leap into a swoon.
   */
  inRate: 26,
  outRate: 20,

  /**
   * The LANDING crouch.
   *
   * Longer and deeper than the flying game's settle, because this is a
   * two-ton walker arriving: the knees fold, the hips drop and the whole frame
   * compresses before it comes back up. It is the clearest single signal that
   * the mech has mass.
   */
  landDuration: 0.22,
  landDrop: 0.45,
  landThigh: deg(-26),
  landKnee: deg(38),
  landArm: deg(-18),
} as const;

/** The fall-over. Readable, brief, and deliberately not gruesome. */
export const DEATH = {
  /** Seconds the whole animation runs before the respawn is applied. */
  duration: 0.55,
  /** How far the mech keels over, in radians. */
  roll: deg(96),
  /** How far it pitches forward as it goes. */
  pitch: deg(24),
  /** How far the body sinks. */
  drop: 0.8,
} as const;

/**
 * The pilot.
 *
 * A single held pose plus secondary motion - which is the whole brief: the
 * player should look like they are FLYING THE MACHINE rather than frozen, and
 * the mech is what carries the performance.
 *
 * THEY ARE STANDING IN THE COCKPIT, not sitting on anything. Their feet are on
 * the cockpit floor, their legs are vertical and entirely inside the chest
 * armour, and their hands are forward on the controls at the dash. Only the
 * arms, shoulders and head are ever seen, so the arms are where all the
 * character is.
 *
 * The pilot's WALK CYCLE NEVER PLAYS. A pilot whose legs cycle while they are
 * strapped into a machine is the single most obvious way a mounted character
 * looks wrong, so the locomotion cycle does not exist on this side of the
 * mount. The mech does all the walking.
 */
export const RIDE = {
  /** The piloting pose, held while driving. */
  pose: {
    /*
     * Legs VERTICAL and very slightly apart.
     *
     * They are inside the chest and will never be seen, and that is exactly
     * why they must not be posed: a seated pose here swings the knees forward
     * through the dash plate and out of the front of the machine, which is the
     * one part of the pilot the cockpit cannot hide.
     */
    LegL1: { x: deg(-2), y: deg(5) },
    LegR1: { x: deg(-2), y: deg(-5) },
    LegL2: { x: deg(4) },
    LegR2: { x: deg(4) },
    // Arms forward and down onto the control grips, elbows out a little so the
    // silhouette above the rim is a person working rather than a person
    // reaching.
    ArmL1: { x: deg(-62), y: deg(-16), z: deg(12) },
    ArmR1: { x: deg(-62), y: deg(16), z: deg(-12) },
    ArmL2: { x: deg(46) },
    ArmR2: { x: deg(46) },
    // Leaning into the glass.
    Spine1: { x: deg(11) },
    Spine2: { x: deg(4) },
    Neck1: { x: deg(-11) },
  } satisfies PoseDefinition,

  /**
   * Amplitude of the pilot's own bounce against the mech's footfalls.
   *
   * SMALL. They are strapped into a cockpit on a suspended seat, not perched
   * on a saddle: what they do on a heavy footfall is absorb it, and a pilot
   * bobbing as hard as the machine does looks like a loose part.
   */
  bounce: { hover: deg(2), cruise: deg(4.5) },
  /** Vertical give in the harness, in world units. */
  postingHeight: { hover: 0.015, cruise: 0.04 },
  /** Extra forward lean at full run - the pilot driving it on. */
  cruiseLean: deg(12),
  /**
   * Extra forward lean while the mech is CLIMBING out of a jump.
   *
   * Layered on top of the mech's own attitude rather than replacing it: the
   * frame leans back off the launch and the rider leans in, which together
   * read as someone riding a leap rather than as a passenger being tipped
   * backward.
   */
  climbLean: deg(15),
  /** How far the arms reach forward through a leap. */
  climbArmReach: deg(-16),
  /** Idle breathing, so a stopped rider is never completely still. */
  breathFrequency: 0.4,
  breathAmount: deg(2),

  /** Lean applied while rising and falling, blended by vertical velocity. */
  riseLean: deg(-10),
  fallLean: deg(12),
  /** Arms rise as the mech leaves the ground. */
  jumpArmLift: deg(-24),

  /** How far the rider slumps as the mech goes over. */
  deathSlump: deg(52),
} as const;

/** Seconds a pose change takes to blend in. One number, used everywhere. */
export const POSE_BLEND_RATE = 12;
