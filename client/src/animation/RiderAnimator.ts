import type { Group } from 'three';
import { POSE_BLEND_RATE, RIDE } from '../config/animationConfig.js';
import type { AnimationInput } from './AnimationInput.js';
import { PoseBuffer } from './PoseBuffer.js';
import type { PlayerRig } from './rig/PlayerRig.js';

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * The rider's animator.
 *
 * The player is a PASSENGER, and this file is what makes that read. There is
 * exactly one looping animation - the seated ride - plus secondary motion
 * layered on top: a bounce against the robot's sway, a forward tuck at speed,
 * a HAUL FORWARD into a climb, and a slump as the robot goes over.
 *
 * Crucially the walking animation NEVER plays. A rider whose legs cycle while
 * they sit astride a robot is the single most obvious way a mounted character
 * looks wrong, so the locomotion cycle simply does not exist on this side of
 * the mount.
 *
 * The climb layer is the half that matters for this game. The robot pitches
 * its whole frame back off a leap; if the rider merely went with it they would read
 * as being tipped backward off the seat. Leaning them FORWARD against that
 * pitch - and reaching the arms out along the shaft - is what turns the same
 * rotation into someone driving a climb.
 *
 * Like the previous game's animator, it writes ONLY to bones and to the
 * supplied visual node. It cannot move the mount, change velocity or decide a
 * gameplay outcome.
 */
export class RiderAnimator {
  private readonly rig: PlayerRig;
  /** Node the vertical posting motion is written to. Never the physics root. */
  private readonly visual: Group;

  /** The pose actually on the skeleton, eased toward `target` every frame. */
  private readonly current = new PoseBuffer();
  private readonly target = new PoseBuffer();

  /** Sway phase, supplied by the robot so the two cannot drift apart. */
  private phase = 0;
  private cruise = 0;
  /** How far into the climb the robot is, handed over by its animator. */
  private climb = 0;
  private time = 0;

  constructor(rig: PlayerRig, visual: Group) {
    this.rig = rig;
    this.visual = visual;
  }

  /** Clear every transient, e.g. after a respawn. */
  reset(): void {
    this.current.reset();
    this.target.reset();
    this.phase = 0;
    this.cruise = 0;
    this.climb = 0;
    this.visual.position.set(0, 0, 0);
    this.visual.rotation.set(0, 0, 0);
    this.rig.resetToBindPose();
  }

  /**
   * @param phase the ROBOT's sway phase, so the rider moves in time with the
   *              thing carrying them rather than to a clock of its own.
   *              Sharing one phase is what makes the pair read as a single
   *              performance.
   * @param climb the robot's own climb blend, 0..1. Taken rather than
   *              re-derived from the grounded flag, so the rider's lean and the
   *              robot's pitch are the SAME curve and cannot ease apart by a
   *              frame at the moment both are most visible.
   */
  update(delta: number, input: AnimationInput, phase: number, climb = 0): void {
    const dt = Math.max(0, delta);
    this.time += dt;
    this.phase = phase;
    this.climb = clamp(climb, 0, 1);

    const scale = Math.max(1, input.moveMultiplier);
    const target = smoothstep(8 * scale, 20 * scale, input.horizontalSpeed);
    this.cruise += (target - this.cruise) * (1 - Math.exp(-6 * dt));

    this.buildTarget(input);

    // Eased rather than snapped, so a landing or a death transition arrives as
    // a movement rather than as a cut.
    const alpha = 1 - Math.exp(-POSE_BLEND_RATE * dt);
    this.current.lerpBetween(this.current, this.target, alpha);

    this.rig.applyPose(this.current);
    this.visual.position.y = this.current.bobY;
  }

  /** Compose the pose this frame should be blending toward. */
  private buildTarget(input: AnimationInput): void {
    const pose = this.target;
    pose.applyDefinition(RIDE.pose);

    if (input.dying) {
      // Thrown forward and sideways as the robot keels: the rider reacts to
      // the fall rather than riding a mount that is no longer upright.
      pose.add('Spine1', RIDE.deathSlump * 0.6, 0, RIDE.deathSlump * 0.5);
      pose.add('Spine2', RIDE.deathSlump * 0.4, 0, RIDE.deathSlump * 0.3);
      pose.add('Neck1', -RIDE.deathSlump * 0.3, 0, 0);
      pose.add('ArmL1', RIDE.jumpArmLift * 1.6, 0, -0.4);
      pose.add('ArmR1', RIDE.jumpArmLift * 1.6, 0, 0.4);
      pose.bobY = -0.12;
      return;
    }

    /*
     * ONE ride pose, whether the robot is on the ground or two hundred units
     * over the lava.
     *
     * There is deliberately no grounded/airborne branch here any more. A rider
     * astride a robot does not change what they are doing when the floor
     * disappears - they are seated either way - and a branch would be a place
     * for the pose to pop on the frame the robot left a ledge, which in this
     * game is most frames.
     */
    const bounce = lerp(RIDE.bounce.hover, RIDE.bounce.cruise, this.cruise);
    const posting = lerp(
      RIDE.postingHeight.hover,
      RIDE.postingHeight.cruise,
      this.cruise,
    );
    const moving = input.horizontalSpeed > 0.6;
    const weight = moving ? 1 : 0;

    const swing = Math.sin(this.phase * 2);

    /*
     * The lean, from three sources that add up rather than compete.
     *
     * The cruise tuck grows with speed; the CLIMB HAUL is the big one and
     * comes straight from the robot's own blend; and the ballistic lean is
     * what is left when neither applies - a rider falling
     * toward a platform, sitting back as the nose drops.
     */
    const rise = clamp(input.verticalVelocity / 16, -1, 1);
    const ballistic = input.grounded
      ? 0
      : rise >= 0
        ? RIDE.riseLean * rise
        : RIDE.fallLean * -rise;
    const lean =
      RIDE.cruiseLean * this.cruise +
      RIDE.climbLean * this.climb +
      ballistic * (1 - this.climb);

    pose.add('Spine1', lean + bounce * swing * weight, 0, 0);
    pose.add('Spine2', lean * 0.4 + bounce * 0.5 * swing * weight, 0, 0);
    // The head counter-rotates so the gaze stays down the course however far
    // the body is leaning - a climbing rider looks where they are going.
    pose.add('Neck1', -lean * 0.75 - bounce * 0.6 * swing * weight, 0, 0);
    // Hands rise and fall a little on the shaft, and reach out into a climb.
    const reach = RIDE.climbArmReach * this.climb + bounce * 0.5 * swing * weight;
    pose.add('ArmL1', reach, 0, 0);
    pose.add('ArmR1', reach, 0, 0);
    // Knees grip a touch harder the faster it goes and harder still climbing.
    const grip = 0.05 * this.cruise + 0.08 * this.climb;
    pose.add('LegL1', 0, 0, -grip);
    pose.add('LegR1', 0, 0, grip);

    pose.bobY = -Math.cos(this.phase * 2) * posting * weight;

    if (!moving && input.grounded) {
      // Standing still: breathing only. Small, slow, and enough that the
      // rider is never a mannequin.
      const breath = Math.sin(this.time * Math.PI * 2 * RIDE.breathFrequency);
      pose.add('Spine1', RIDE.breathAmount * breath, 0, 0);
      pose.add('Neck1', -RIDE.breathAmount * 0.5 * breath, 0, 0);
      pose.bobY = breath * 0.012;
    }
  }
}
