import { RobotAnimationState } from '@robot/shared';
import type { RobotModel } from '../robot/RobotModel.js';
import { AIR, DEATH, GAIT, WALK } from '../config/animationConfig.js';
import type { AnimationInput } from './AnimationInput.js';

const TAU = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth 0..1 ramp between two thresholds. */
const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * THE MECHANICAL WAVE: a sine the machine is allowed to hold still in.
 *
 * The cycle is quantised to `GAIT.keyframes` commanded attitudes. Within each
 * beat the joint sits at the attitude it was driven to for `keyframeHold` of
 * the interval and then travels to the next one over what is left. The poses
 * are the same poses a smooth walk would pass through; the DIFFERENCE is that
 * a machine arrives at a position and stays there, and a person is always
 * mid-way between two.
 *
 * Feeding every joint from this one function is what keeps the whole frame in
 * step: the legs, the arms and the hips all change on the same beat, which is
 * the other half of looking driven rather than animated.
 */
const mechanical = (phase: number): number => {
  const beats = GAIT.keyframes;
  const position = (phase / TAU) * beats;
  const index = Math.floor(position);
  const t = position - index;

  const from = Math.sin((index / beats) * TAU);
  const to = Math.sin(((index + 1) / beats) * TAU);

  // Hold, then drive across. `smoothstep` over the remaining window gives the
  // travel a servo's acceleration and stop rather than a linear slide.
  const travel = smoothstep(GAIT.keyframeHold, 1, t);
  return lerp(from, to, travel);
};

/**
 * The mech animator.
 *
 * The ONLY animation state machine for the robot. It consumes a read-only
 * `AnimationInput` and writes exclusively to the model's animated nodes - the
 * body, the four limbs - plus the neon's brightness. It never moves `root`,
 * never touches velocity, and never decides a gameplay outcome. That is the
 * same separation the previous games enforced, and it is why swapping robots
 * cannot break movement.
 *
 * THERE ARE TWO ANIMATIONS and the difference between them is the whole job of
 * this class:
 *
 *  1. WALK - the legs driven under the frame, arms counter-swinging, the hips
 *     settling on each footfall. One cycle at every speed: `run` deepens it
 *     rather than replacing it, so moving faster reads as a longer stride
 *     rather than as a different animation.
 *
 *     IT IS MECHANICAL, AND THAT IS A PROPERTY OF THE PLAYBACK RATHER THAN OF
 *     THE POSES. The cycle is sampled at `GAIT.keyframes` fixed attitudes and
 *     every joint HOLDS at one before travelling quickly to the next, the way
 *     a servo drives to a commanded position. The frame itself stays rigid:
 *     there is no side-to-side sway, no idle wobble and no squash on landing,
 *     because a two-ton walker has none of those and putting them on one is
 *     what made this mech read as a person dancing.
 *  2. JUMP - knees drawn up and arms thrown back on the way up, legs reaching
 *     for the deck on the way down, and a real crouch on landing. The two
 *     halves are told apart by the SIGN of vertical velocity, not by a state
 *     machine, so the top of an arc rolls over smoothly instead of snapping.
 *
 * The walk phase advances with DISTANCE, not wall-clock time, so the feet stay
 * in step with real movement - and the cadence is clamped, so they stay
 * readable when a late-game mech is covering four hundred units a second.
 */
export class RobotAnimator {
  private readonly model: RobotModel;

  private phase = 0;
  private state: RobotAnimationState = RobotAnimationState.Idle;

  /** Seconds into the landing crouch, or the death. */
  private landTime = -1;
  private deathTime = -1;

  /** Smoothed lean into a steer, so turning does not snap the frame over. */
  private bank = 0;

  /** Smoothed run blend, so a speed spike does not pop the pose. */
  private run = 0;

  /**
   * Smoothed AIR blend, 0 planted and 1 fully airborne.
   *
   * Rises fast and falls a little slower, deliberately: leaving the ground
   * should look like it happened on the frame it did, and touching down should
   * hand over to the landing crouch rather than snapping straight to a walk.
   */
  private air = 0;

  constructor(model: RobotModel) {
    this.model = model;
  }

  get currentState(): RobotAnimationState {
    return this.state;
  }

  /**
   * The walk phase, in radians.
   *
   * Handed to the rider so both halves of the mount move to the SAME cycle. A
   * rider running its own clock is what makes a mounted pair look like two
   * animations played at each other rather than one performance.
   */
  get gaitPhase(): number {
    return this.phase;
  }

  /** How far into the air pose the mech is, 0..1. Read by the rider. */
  get climbBlend(): number {
    return this.air;
  }

  /** Seconds the death animation has been running, or -1. */
  get deathProgress(): number {
    return this.deathTime < 0 ? -1 : clamp(this.deathTime / DEATH.duration, 0, 1);
  }

  /** Clear every transient, e.g. after a respawn. */
  reset(): void {
    this.phase = 0;
    this.landTime = -1;
    this.deathTime = -1;
    this.bank = 0;
    this.run = 0;
    this.air = 0;
    this.state = RobotAnimationState.Idle;
    this.model.resetPose();
  }

  update(delta: number, input: AnimationInput): void {
    const dt = Math.max(0, delta);

    if (input.dying) {
      this.deathTime = this.deathTime < 0 ? 0 : this.deathTime + dt;
      this.state = RobotAnimationState.Dying;
      this.writeDeath();
      return;
    }
    this.deathTime = -1;

    if (input.landed) this.landTime = 0;
    if (this.landTime >= 0) {
      this.landTime += dt;
      if (this.landTime > AIR.landDuration) this.landTime = -1;
    }

    // The run blend is measured against the player's OWN authoritative speed
    // scale, so "running" means the same thing at level 1 and level 160.
    const scale = Math.max(1, input.moveMultiplier);
    const target = smoothstep(
      GAIT.walkSpeed * scale,
      GAIT.runSpeed * scale,
      input.horizontalSpeed,
    );
    this.run += (target - this.run) * (1 - Math.exp(-6 * dt));

    const airRate = input.grounded ? AIR.outRate : AIR.inRate;
    this.air += ((input.grounded ? 0 : 1) - this.air) * (1 - Math.exp(-airRate * dt));

    const stride = this.model.definition.strideLength;
    const frequency = clamp(
      input.horizontalSpeed / stride,
      GAIT.minFrequency,
      GAIT.maxFrequency,
    );

    const moving = input.horizontalSpeed > GAIT.idleSpeed;
    if (moving) {
      this.phase = (this.phase + frequency * TAU * dt) % TAU;
    } else {
      // Ease back toward a neutral phase, so setting off never begins with the
      // mech already mid-stride on one leg.
      const settleTarget = this.phase > Math.PI ? TAU : 0;
      this.phase += (settleTarget - this.phase) * (1 - Math.exp(-8 * dt));
      if (this.phase >= TAU - 1e-4) this.phase = 0;
    }

    this.bank +=
      (clamp(input.turn, -1, 1) * -GAIT.bankAngle - this.bank) *
      (1 - Math.exp(-GAIT.bankRate * dt));

    this.state = resolveState(input, moving, this.run, this.landTime);
    this.write(input, moving);
  }

  /**
   * ONE pose, blended.
   *
   * Every attitude this mech ever holds is written here from four numbers:
   * `run` (how fast), `air` (how far off the ground), the vertical velocity
   * (which way it is going) and the landing timer. There is deliberately no
   * branch between a "walking" and an "airborne" skeleton - the limbs are the
   * same limbs and a branch would be somewhere for the two halves to disagree
   * on the frame it changed.
   */
  private write(input: AnimationInput, moving: boolean): void {
    const model = this.model;
    const parts = model.parts;

    /*
     * A PARKED MECH IS PARKED.
     *
     * Standing still the cycle stops dead - no residual amplitude, no
     * wall-clock tick-over, no breathing. A machine at rest holds its
     * position, and the idle sway this used to run was the single most
     * organic-looking thing the mech did.
     */
    const weight = moving ? 1 : 0;
    const cyclePhase = this.phase;

    // ---- The ground pose --------------------------------------------------
    const swing = lerp(WALK.thighSwing.walk, WALK.thighSwing.run, this.run) * weight;
    const knee = lerp(WALK.kneeBend.walk, WALK.kneeBend.run, this.run) * weight;
    const armSwing = lerp(WALK.armSwing.walk, WALK.armSwing.run, this.run) * weight;
    const elbow = lerp(WALK.elbowBend.walk, WALK.elbowBend.run, this.run) * weight;

    // The driven cycle. Every joint below reads from this, so the whole frame
    // changes attitude on the same beat.
    const sin = mechanical(cyclePhase);
    // The two legs are half a cycle apart. That is the whole of a biped gait.
    const legLSwing = sin * swing;
    const legRSwing = -sin * swing;

    /*
     * The knee folds on the BACK half of the stride only.
     *
     * `max(0, -sin)` is one-sided on purpose: a mech knee bends one way, and a
     * symmetric sine would fold it forward for half of every step. That single
     * error is the most obvious way a procedural walk betrays itself.
     */
    const legLKnee = Math.max(0, -sin) * knee;
    const legRKnee = Math.max(0, sin) * knee;

    // ---- The air pose -----------------------------------------------------
    const rise = clamp(input.verticalVelocity / AIR.velocityReference, -1, 1);
    // 1 fully rising, 0 fully falling. The roll-over at the top of an arc is
    // this crossing 0.5, which is why it is a lerp and not a branch.
    const up = (rise + 1) / 2;
    const airThigh = lerp(AIR.fallThigh, AIR.jumpThigh, up);
    const airKnee = lerp(AIR.fallKnee, AIR.jumpKnee, up);
    const airArm = lerp(AIR.fallArm, AIR.jumpArm, up);
    const airPitch = lerp(AIR.fallPitch, AIR.risePitch, up);

    // ---- The landing crouch ----------------------------------------------
    const settle =
      this.landTime >= 0 ? 1 - clamp(this.landTime / AIR.landDuration, 0, 1) : 0;

    // ---- Resolve ----------------------------------------------------------
    //
    // Every joint is ONE lerp from its ground value to its air value by `a`,
    // plus the landing crouch on top. No branches: the whole skeleton crosses
    // between the two poses together, which is what makes leaving the ground
    // and touching down read as one continuous movement.
    const a = this.air;
    model.legL.rotation.set(lerp(legLSwing, airThigh, a) + AIR.landThigh * settle, 0, 0);
    model.legR.rotation.set(lerp(legRSwing, airThigh, a) + AIR.landThigh * settle, 0, 0);
    model.kneeL.rotation.set(lerp(legLKnee, airKnee, a) + AIR.landKnee * settle, 0, 0);
    model.kneeR.rotation.set(lerp(legRKnee, airKnee, a) + AIR.landKnee * settle, 0, 0);

    // Arms counter-swing: the LEFT arm goes with the RIGHT leg, always. That
    // is what a biped does and the single cheapest way to make a walk cycle
    // look deliberate.
    const armL = -sin * armSwing;
    const armR = sin * armSwing;
    model.armL.rotation.set(lerp(armL, airArm, a) + AIR.landArm * settle, 0, 0);
    model.armR.rotation.set(lerp(armR, airArm, a) + AIR.landArm * settle, 0, 0);
    // The elbows are held bent rather than swung: a mech's forearms track the
    // upper arm and only tighten as it drives harder.
    model.elbowL.rotation.set(elbow + Math.max(0, armL) * 0.4, 0, 0);
    model.elbowR.rotation.set(elbow + Math.max(0, armR) * 0.4, 0, 0);

    /*
     * The bob, TWICE per cycle.
     *
     * A biped's hips rise and fall on every footfall and there are two of
     * those per stride, so the bob runs at double the phase. Bobbing once per
     * cycle is what makes a walk read as a limp.
     */
    const bobAmount = lerp(WALK.bob.walk, WALK.bob.run, this.run) * weight;
    const bob = -Math.abs(mechanical(cyclePhase)) * bobAmount;

    const lean = lerp(WALK.lean.idle, WALK.lean.run, this.run) * (moving ? 1 : 0);

    model.body.position.set(
      0,
      parts.hipY + lerp(bob, 0, a) - AIR.landDrop * settle,
      0,
    );
    model.body.rotation.set(
      lerp(lean, airPitch, a),
      0,
      /*
       * THE ONLY ROLL THE FRAME EVER HAS, and it is the steering lean.
       *
       * There is deliberately no walk-cycle roll added to it. A sway term here
       * is what made the mech wobble from side to side down a straight
       * corridor, and a machine walking in a straight line does not move on
       * this axis at all.
       */
      this.bank,
    );
    /*
     * NO SQUASH. The frame is rigid.
     *
     * Landing used to compress the body and spring it back, which is cartoon
     * weight - it belongs on something soft. A mech absorbs a landing in its
     * KNEES and its hip height, which the crouch pose and `landDrop` above
     * already do, and its armour does not change shape.
     */
    model.body.scale.set(1, 1, 1);

    // The neon brightens as the mech works, so a frame seen head-on - with no
    // attitude to read - still says whether it is moving.
    model.setGlow(this.run * 0.7 + a * 0.3);
  }

  /**
   * The fall-over.
   *
   * The mech keels onto one side, pitches forward and sinks, legs going limp.
   * Simple and readable, exactly like the rest of the visual language - this
   * is a toy walker toppling, not a ragdoll.
   */
  private writeDeath(): void {
    const model = this.model;
    const t = clamp(this.deathTime / DEATH.duration, 0, 1);
    // Ease-out, so it goes over quickly and settles rather than rotating at a
    // constant rate like a turntable.
    const eased = 1 - (1 - t) * (1 - t);

    model.body.position.set(0, model.parts.hipY - DEATH.drop * eased, 0);
    model.body.rotation.set(DEATH.pitch * eased, 0, DEATH.roll * eased);
    model.body.scale.set(1, 1, 1);
    model.legL.rotation.set(0.5 * eased, 0, 0);
    model.legR.rotation.set(0.2 * eased, 0, 0);
    model.armL.rotation.set(-0.6 * eased, 0, 0);
    model.armR.rotation.set(-0.4 * eased, 0, 0);
    model.setGlow(0);
  }
}

const resolveState = (
  input: AnimationInput,
  moving: boolean,
  run: number,
  landTime: number,
): RobotAnimationState => {
  if (!input.grounded) {
    return input.verticalVelocity > 0
      ? RobotAnimationState.Jumping
      : RobotAnimationState.Falling;
  }
  if (landTime >= 0) return RobotAnimationState.Landing;
  if (!moving) return RobotAnimationState.Idle;
  return run > 0.5 ? RobotAnimationState.Run : RobotAnimationState.Walk;
};
