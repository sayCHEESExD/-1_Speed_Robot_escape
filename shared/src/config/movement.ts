import { rebirthMultiplier } from './rebirth.js';

/**
 * Movement tuning for a RIDDEN MECH.
 *
 * The client predicts with these numbers and the server simulates with them,
 * so they must not diverge - which is why there is one copy, here.
 *
 * The ROBOT is the movement character: it walks, it turns, it jumps, and it is
 * what the collision body belongs to. The rider is carried on its shoulders
 * and has no physics of their own.
 *
 * There is exactly ONE airborne mechanic and it is a JUMP: a single impulse on
 * a fresh press from the ground. No meter, no hold, no thrust. A mech walks
 * and it leaps, and the whole obby is authored against how far one leap goes.
 *
 * THERE IS ALSO EXACTLY ONE GROUND GAIT. A mech walks, at `moveSpeed`, and
 * there is no sprint: no Shift, no run key, no second speed on the stick. The
 * input carries no such flag, the shared step reads no such flag, and the
 * server has nothing to validate against one. Every gap in thirty stages is
 * authored against this single number through `ballisticFor`, so a second
 * ground speed would not be a feature - it would be a second course.
 */
export interface MovementConfig {
  /**
   * THE ground speed, in world units per second, before every multiplier.
   *
   * One number, because there is one gait. `ballisticFor` turns it and
   * `jumpVelocity` into the reach every gap in the course is measured with, so
   * this is the figure the whole obby is authored against.
   */
  readonly moveSpeed: number;
  /** Ground acceleration, world units per second squared. */
  readonly acceleration: number;
  /** Ground deceleration when the stick is released. */
  readonly deceleration: number;
  /** Fraction of ground acceleration retained while airborne (0..1). */
  readonly airControl: number;
  /** Downward acceleration, world units per second squared. */
  readonly gravity: number;
  /**
   * Upward velocity applied by a jump, world units per second.
   *
   * The ONE number every gap in the course is authored against, through
   * `ballisticFor`. A mech is heavy, so gravity is strong and the impulse is
   * large: the arc is short and punchy rather than floaty, which is what makes
   * a two-ton walker feel like one.
   */
  readonly jumpVelocity: number;
  /**
   * Turn rate toward the movement direction, radians per second.
   *
   * Slower than a person on foot on purpose: a mech PIVOTS, and an instant
   * snap is what makes a walker read as a floating camera.
   */
  readonly turnSpeed: number;
  /**
   * Largest distance the simulation will integrate in one substep.
   *
   * THE reason this game has no speed cap. Late-game movement runs at hundreds
   * of units a second, and a single 1/60s step at that speed would step clean
   * over a platform, a pillar and the gap beyond it. `stepPlayer` subdivides
   * its own step until every substep moves less than this, so collision is
   * exactly as reliable at 400 u/s as at 20.
   */
  readonly maxSubstepDistance: number;
  /** Most substeps one step may take, so a pathological speed cannot hang. */
  readonly maxSubsteps: number;
  /**
   * Height the mech steps up without jumping.
   *
   * A platform lip, a deck edge and the 0.6-unit display plinths are all below
   * this, so the hangar never asks for a jump over something that reads as a
   * kerb. It must stay equal to `LANDING_TOLERANCE` in `WorldCollision`: when
   * the two disagreed, every ledge between them was reported as the floor and
   * then refused as a landing, and the mech fell through solid ground.
   */
  readonly stepHeight: number;
}

/**
 * Tuned for a WORLD SCALE of about 1.45x the previous game's.
 *
 * Speed, launch and gravity were all multiplied together rather than
 * separately, and that is the whole trick: airtime is `2v/g`, so scaling v and
 * g by the same factor leaves the arc's DURATION untouched while its reach and
 * its rise both grow by that factor. The facility got bigger, the mech got
 * bigger, and the game still feels exactly the same in the hand.
 *
 * Change one of the three and you have changed how the game feels. Change all
 * three and you have changed how big the world is.
 */
export const MOVEMENT: MovementConfig = {
  moveSpeed: 35,
  acceleration: 123,
  deceleration: 87,
  airControl: 0.5,
  gravity: 90,
  jumpVelocity: 44,
  turnSpeed: 7,
  maxSubstepDistance: 1.15,
  maxSubsteps: 48,
  stepHeight: 1.35,
};

/**
 * How level, rebirths, the robot and the equipped trail combine into ONE
 * movement profile.
 *
 * This is the single evaluator: nothing else may compute a movement speed.
 * The server resolves it and replicates the multiplier; the client multiplies
 * the base speeds above by exactly that and never derives its own.
 */
export interface MovementProfile {
  /** Multiplier on `moveSpeed`. */
  readonly multiplier: number;
  /** Resolved ground speed in world units per second. */
  readonly moveSpeed: number;
  /** Resolved jump velocity. */
  readonly jumpVelocity: number;
}

/** Speed added per level, as a fraction of the base. */
const SPEED_PER_LEVEL = 0.04;

/**
 * Levels over which the per-level gain decays to half its value.
 *
 * The level term used to be LINEAR, and that is what made the mount
 * unmanageable: every level added the same slab of speed for ever, so a
 * mid-game player was already outrunning the platforms they had to read.
 *
 * Now it tapers: `steps / (1 + steps / LEVEL_SOFT_CAP)` rises quickly at
 * first, so the first twenty levels still feel like getting faster, and
 * converges on `SPEED_PER_LEVEL * LEVEL_SOFT_CAP` - a level ceiling of x2
 * however long anyone grinds.
 *
 * Levelling is therefore not where late-game speed comes from. REBIRTH and
 * TRAILS are, which is what those two ladders are for and why they are
 * untouched here.
 */
const LEVEL_SOFT_CAP = 25;

/**
 * Resolve the profile a player actually moves at.
 *
 * THE single evaluator. Every modifier in the game is a FACTOR fed through
 * here - the equipped robot, the equipped trail, the rebirth ladder - and none
 * of them is ever a second formula somewhere else.
 *
 * @param level       current level, 1-based
 * @param rebirths    completed rebirth count
 * @param robotMove   the equipped robot's `moveBonus`
 * @param robotJump   the equipped robot's `jumpBonus`
 * @param extra       the equipped trail's multiplier, and any future boost
 */
export const resolveMovementProfile = (
  level: number,
  rebirths: number,
  robotMove = 1,
  robotJump = 1,
  extra = 1,
): MovementProfile => {
  const steps = Math.max(0, Math.floor(level) - 1);
  const safe = (value: number): number =>
    Number.isFinite(value) && value > 0 ? value : 1;

  // Diminishing returns, so a very high level is faster than a high one
  // without being a different game.
  const levelGain = (steps / (1 + steps / LEVEL_SOFT_CAP)) * SPEED_PER_LEVEL;

  const multiplier =
    (1 + levelGain) *
    rebirthMultiplier(rebirths) *
    safe(robotMove) *
    safe(extra);

  return {
    multiplier,
    moveSpeed: MOVEMENT.moveSpeed * multiplier,
    /*
     * Jump velocity scales FAR more gently than travel speed, and that
     * asymmetry is what keeps the course honest.
     *
     * A jump that grew with the full multiplier would let a rebirthed player
     * clear every vertical step in the game, and the obby's whole difficulty
     * curve past stage 10 is elevation. Travel speed runs away and jump HEIGHT
     * barely moves, so a faster mech jumps FURTHER and no higher - which is
     * exactly the trade the stage builders are authored against.
     */
    jumpVelocity:
      MOVEMENT.jumpVelocity * safe(robotJump) * (1 + Math.min(multiplier - 1, 6) * 0.07),
  };
};
