import { surfaceAt, treadmillAt } from '../config/course.js';
import { MOVEMENT } from '../config/movement.js';
import { MOUNT_HEIGHT } from '../constants/world.js';
import { SPAWN_POSITION, SPAWN_ROTATION_Y } from '../constants/world.js';
import { rotateTowards } from '../types/math.js';
import type { WorldCollision } from './WorldCollision.js';

/**
 * The authoritative physics step, shared by the server and by client
 * prediction.
 *
 * This is THE movement simulation. The server runs it to own the result and
 * the client runs the identical function to predict ahead of the network, so
 * the two can only ever disagree through inputs, never through different
 * maths. Do not reimplement any part of it anywhere else.
 *
 * What moves is the ROBOT. The rider is carried on its shoulders: they have no
 * velocity, no collision and no state here, which is exactly why swapping the
 * robot can never change how movement works.
 *
 * Deliberately framework-free and allocation-free: plain numbers on a mutable
 * state object, so it runs in Node and in the browser at any tick rate.
 */

/** Everything that makes up a mech's physical state. */
export interface PlayerMotion {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  grounded: boolean;
  /** Edge-detect for the jump control, so a hold is one leap, not sixty. */
  jumpLatched: boolean;
  /** Monotonic count of jumps, replicated so remotes can mirror them. */
  jumpCount: number;
  /**
   * Treadmill the player is standing on, or 0.
   *
   * DERIVED from position every step by both sides, never sent. Walking on
   * starts it and walking off stops it, so there is no message to forge and
   * nothing to keep after stepping off. It changes no physics at all - it only
   * tells the Speed service to bill the belt instead of the ground, and the
   * animator to walk on the spot.
   */
  treadmill: number;
  /**
   * Seconds of coyote time left.
   *
   * A mech that runs off the lip of a platform at three hundred units a second
   * has left the ground before the player could possibly have reacted. This is
   * the grace window in which the jump still counts, and it is part of the
   * SIMULATION rather than the input layer so the server grants exactly the
   * same window the client predicted.
   */
  coyote: number;
}

/** One frame of player intent. Carries no position - only what was pressed. */
export interface MovementInput {
  /** -1..1, camera-relative. */
  moveX: number;
  /** -1..1, camera-relative. */
  moveZ: number;
  /** The jump key (Space), held. Only the fresh PRESS does anything. */
  jump: boolean;
  /** Yaw the camera faced, so movement can be camera-relative. */
  cameraYaw: number;
}

/** Server-owned tuning the step reads but never changes. */
export interface SimParams {
  /** Authoritative movement multiplier from level, rebirths, robot and trail. */
  moveMultiplier: number;
  /** Authoritative jump velocity, resolved by the one shared formula. */
  jumpVelocity: number;
  /**
   * The world clock, in seconds.
   *
   * Sinking platforms and moving hazards are pure functions of it, so the step
   * has to know WHEN it is happening as well as what was pressed. The server
   * passes its own elapsed time; the client passes its estimate of the same,
   * and is corrected if it guessed wrong.
   */
  time: number;
}

/** Edges this step produced, consumed by the animator. */
export interface SimEvents {
  jumpStarted: boolean;
  landed: boolean;
}

/** Largest single step the simulation will take, in seconds. */
export const MAX_SIM_DELTA = 0.1;

/** Seconds after leaving the ground during which a jump still counts. */
const COYOTE_TIME = 0.11;

export const createMotion = (): PlayerMotion => ({
  x: SPAWN_POSITION.x,
  y: SPAWN_POSITION.y,
  z: SPAWN_POSITION.z,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: SPAWN_ROTATION_Y,
  grounded: true,
  jumpLatched: false,
  jumpCount: 0,
  treadmill: 0,
  coyote: 0,
});

export const createSimEvents = (): SimEvents => ({
  jumpStarted: false,
  landed: false,
});

export const createMovementInput = (): MovementInput => ({
  moveX: 0,
  moveZ: 0,
  jump: false,
  cameraYaw: 0,
});

/** Copy motion state, e.g. when snapping prediction to the server. */
export const copyMotion = (from: PlayerMotion, to: PlayerMotion): void => {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.vx = from.vx;
  to.vy = from.vy;
  to.vz = from.vz;
  to.yaw = from.yaw;
  to.grounded = from.grounded;
  to.jumpLatched = from.jumpLatched;
  to.jumpCount = from.jumpCount;
  to.treadmill = from.treadmill;
  to.coyote = from.coyote;
};

/** Reset to a spawn transform. Used by both sides on respawn. */
export const resetMotion = (
  motion: PlayerMotion,
  x = SPAWN_POSITION.x,
  y = SPAWN_POSITION.y,
  z = SPAWN_POSITION.z,
  yaw = SPAWN_ROTATION_Y,
): void => {
  motion.x = x;
  motion.y = y;
  motion.z = z;
  motion.vx = 0;
  motion.vy = 0;
  motion.vz = 0;
  motion.yaw = yaw;
  motion.grounded = true;
  motion.jumpLatched = false;
  motion.treadmill = 0;
  motion.coyote = 0;
};

export const horizontalSpeed = (motion: PlayerMotion): number =>
  Math.hypot(motion.vx, motion.vz);

/**
 * Sanitise one input before it is simulated.
 *
 * Applied on the SERVER to every arriving input: a client may send whatever it
 * likes, but the stick is clamped to the unit disc and every field is forced
 * finite, so an out-of-range or NaN input cannot become out-of-range movement.
 */
export const sanitiseInput = (
  input: Partial<MovementInput> | undefined,
): MovementInput => {
  const finite = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  let moveX = finite(input?.moveX);
  let moveZ = finite(input?.moveZ);
  const magnitude = Math.hypot(moveX, moveZ);
  if (magnitude > 1) {
    moveX /= magnitude;
    moveZ /= magnitude;
  }

  return {
    moveX,
    moveZ,
    jump: input?.jump === true,
    cameraYaw: finite(input?.cameraYaw),
  };
};

/** Scratch for the boundary clamp. Single-threaded, so sharing is safe. */
const BOUNDS = { x: 0, z: 0 };

/**
 * Advance one mech by one step.
 *
 * @param motion    mutated in place
 * @param input     already sanitised intent
 * @param params    server-owned tuning
 * @param delta     seconds; clamped internally to [0, MAX_SIM_DELTA]
 * @param collision the course the mech moves through
 * @param events    mutated in place with the edges this step produced
 */
export const stepPlayer = (
  motion: PlayerMotion,
  input: MovementInput,
  params: SimParams,
  delta: number,
  collision: WorldCollision,
  events: SimEvents,
): void => {
  events.jumpStarted = false;
  events.landed = false;

  const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), MAX_SIM_DELTA) : 0;
  if (dt === 0) return;

  // ONE instant for the whole step, including every substep and every replayed
  // step during reconciliation. A platform that moved between two substeps of
  // the same frame would make the floor disagree with itself.
  collision.setTime(params.time);

  const wasGrounded = motion.grounded;

  applyJump(motion, input, params, events);
  applyHorizontal(motion, input, params, dt);
  motion.vy -= MOVEMENT.gravity * dt;

  // SUBSTEPPING is what removes the speed cap.
  //
  // Late game moves at hundreds of units a second. Integrating that in one
  // 1/60s step would displace the mech five metres at once, straight through a
  // platform, a pillar and the gap past it - so the old answer was always to
  // cap the speed. Instead the step is subdivided until no substep travels
  // further than `maxSubstepDistance`, which makes collision exactly as
  // reliable at 400 u/s as at 20 and lets the progression curve run as far as
  // it likes.
  const travel = Math.hypot(motion.vx, motion.vy, motion.vz) * dt;
  const substeps = Math.max(
    1,
    Math.min(Math.ceil(travel / MOVEMENT.maxSubstepDistance), MOVEMENT.maxSubsteps),
  );
  const sub = dt / substeps;

  for (let i = 0; i < substeps; i += 1) {
    integrate(motion, sub, collision);
  }

  // Coyote time is spent by wall-clock, not by substep, so it is the same
  // window however fast the player is moving.
  if (motion.grounded) motion.coyote = COYOTE_TIME;
  else motion.coyote = Math.max(0, motion.coyote - dt);

  /*
   * LAUNCH PADS, applied after the substeps from the position the step
   * actually finished in.
   *
   * Evaluated here rather than inside `integrate` for two reasons. A pad has
   * to see a SETTLED contact - a mech that clipped the corner of one for a
   * single substep has not stood on it - and a boost applied per substep would
   * fire several times in one frame and throw the player into the roof.
   *
   * It is a SET, not an add, so every mech leaves a pad at the same speed
   * whatever it arrived doing. That is what makes a pad a measurable route: a
   * player can learn exactly where one lands them and it stays true at level
   * 160.
   */
  if (motion.grounded) {
    const pad = surfaceAt(motion.x, motion.z);
    if (pad && pad.boost > 0) {
      motion.vy = pad.boost;
      motion.grounded = false;
      motion.coyote = 0;
      // Counted as a jump, so the animator leaps and the Speed service pays
      // the airborne bonus exactly as it would for one the player pressed.
      motion.jumpCount += 1;
      events.jumpStarted = true;
    }
  }

  // Derived last, from the position this step actually reached.
  motion.treadmill = motion.grounded ? treadmillAt(motion.x, motion.y, motion.z) : 0;

  if (!wasGrounded && motion.grounded) events.landed = true;
};

/**
 * One substep: move, then resolve, one axis at a time.
 *
 * Axis-separated resolution is exact for an axis-aligned course and cannot
 * oscillate, which a combined push-out can. The vertical pass runs last so the
 * ground test sees the horizontally-corrected position rather than one that is
 * still inside a pillar.
 */
const integrate = (motion: PlayerMotion, dt: number, collision: WorldCollision): void => {
  const previousY = motion.y;

  motion.x += motion.vx * dt;
  const correctedX = collision.resolveAxis(0, motion.x, motion.z, motion.y);
  if (correctedX !== motion.x) {
    motion.x = correctedX;
    // Kill only the component that hit the wall, so the mech slides along it
    // instead of stopping dead against every pillar.
    motion.vx = 0;
  }

  motion.z += motion.vz * dt;
  const correctedZ = collision.resolveAxis(2, motion.z, motion.x, motion.y);
  if (correctedZ !== motion.z) {
    motion.z = correctedZ;
    motion.vz = 0;
  }

  motion.y += motion.vy * dt;

  collision.clampToBounds(motion.x, motion.z, BOUNDS);
  motion.x = BOUNDS.x;
  motion.z = BOUNDS.z;

  resolveCeiling(motion, previousY, collision);
  resolveGround(motion, previousY, collision);
};

/**
 * The jump.
 *
 * ONE impulse, on the frame the key goes down, and only from the ground or
 * inside the coyote window. There is no hold, no double jump and no meter: the
 * whole obby is authored against the arc this produces, and a second airborne
 * mechanic would invalidate every gap in it.
 *
 * The latch is what makes a held key one leap rather than sixty: it is
 * replicated, so the client's replay derives exactly the same edges the server
 * took.
 */
const applyJump = (
  motion: PlayerMotion,
  input: MovementInput,
  params: SimParams,
  events: SimEvents,
): void => {
  const pressed = input.jump && !motion.jumpLatched;
  motion.jumpLatched = input.jump;
  if (!pressed) return;
  if (!motion.grounded && motion.coyote <= 0) return;

  // `Math.max` rather than an assignment: a mech already rising off a moving
  // platform must not have its climb cut short by its own jump.
  motion.vy = Math.max(motion.vy, params.jumpVelocity);
  motion.grounded = false;
  motion.coyote = 0;
  motion.jumpCount += 1;
  events.jumpStarted = true;
};

const applyHorizontal = (
  motion: PlayerMotion,
  input: MovementInput,
  params: SimParams,
  dt: number,
): void => {
  const hasInput = input.moveX !== 0 || input.moveZ !== 0;

  // Rotate the raw stick into world space using the camera's yaw.
  //
  // The camera looks along (sin, cos); its RIGHT is (-cos, sin), because with
  // Y up and X to the right of screen, +Z runs away from the viewer. Getting
  // this backwards inverts strafing, and a camera that trailed the player's
  // own facing would hide it completely - which is exactly why the camera owns
  // its yaw here and movement is resolved against it.
  const sin = Math.sin(input.cameraYaw);
  const cos = Math.cos(input.cameraYaw);
  const dirX = input.moveZ * sin - input.moveX * cos;
  const dirZ = input.moveZ * cos + input.moveX * sin;

  /*
   * ONE speed, because there is one gait.
   *
   * There is no sprint in this game: no modifier key, no stick threshold, no
   * second base speed to pick between. `MOVEMENT.moveSpeed` is what a mech
   * walks at and what every gap in the course was measured against.
   */
  const targetSpeed = MOVEMENT.moveSpeed * params.moveMultiplier;
  const control = motion.grounded ? 1 : MOVEMENT.airControl;

  /*
   * The ground the mech is over, if it is anything other than ordinary.
   *
   * Read HERE, inside the shared step, rather than applied as a force by
   * either side separately: slick plating and blowing vents change how the
   * controls answer, and a client whose prediction handled differently from
   * the server's simulation would spend the whole stage being pulled back to a
   * position it did not steer to. There is one formula and both sides run it.
   */
  const surface = surfaceAt(motion.x, motion.z);

  // Grip scales acceleration and braking TOGETHER. Lowering only the braking
  // would make slick plating a place where the mech is harder to stop; lowering
  // both is what makes it a place where it is harder to steer, which is the
  // mechanic.
  const grip = surface && motion.grounded ? Math.max(0.05, surface.grip) : 1;

  /*
   * Conveyor and vent forces act in the AIR as well as on the ground.
   *
   * A jump across a conveyor bay that went exactly where it was aimed would
   * make the whole stage cosmetic - the belt has to keep pushing the thing it
   * threw.
   */
  if (surface) {
    motion.vx += surface.windX * dt;
    motion.vz += surface.windZ * dt;
  }

  if (hasInput) {
    // Acceleration scales with the target speed, so reaching top speed takes
    // about the same time at every level. A fixed acceleration would leave a
    // late-game mech spending several seconds winding up.
    const accel = MOVEMENT.acceleration * params.moveMultiplier * control * grip * dt;
    const rate = Math.min(accel / targetSpeed, 1);
    motion.vx += (dirX * targetSpeed - motion.vx) * rate;
    motion.vz += (dirZ * targetSpeed - motion.vz) * rate;

    const desiredYaw = Math.atan2(dirX, dirZ);
    motion.yaw = rotateTowards(motion.yaw, desiredYaw, MOVEMENT.turnSpeed * dt);
  } else if (motion.grounded) {
    const drop = MOVEMENT.deceleration * params.moveMultiplier * grip * dt;
    const speed = horizontalSpeed(motion);
    // The speed guard matters independently of `drop`: dividing by a zero
    // speed would yield Infinity, and 0 * Infinity is NaN.
    if (speed <= drop || speed < 1e-6) {
      motion.vx = 0;
      motion.vz = 0;
    } else {
      const scale = (speed - drop) / speed;
      motion.vx *= scale;
      motion.vz *= scale;
    }
  }
};

/**
 * Stop a rising mech at the underside of whatever is above it.
 *
 * Runs BEFORE the ground test, because a mech pushed down out of a ceiling may
 * immediately be standing on something and the ground test should see the
 * corrected height rather than one that is still inside a slab.
 */
const resolveCeiling = (
  motion: PlayerMotion,
  previousY: number,
  collision: WorldCollision,
): void => {
  if (motion.vy <= 0) return;

  const ceiling = collision.ceilingYAt(motion.x, motion.z, previousY + MOUNT_HEIGHT);
  if (ceiling === null) return;
  if (motion.y + MOUNT_HEIGHT <= ceiling) return;

  motion.y = ceiling - MOUNT_HEIGHT;
  // The climb stops dead; horizontal travel is untouched, so a mech that clips
  // a corner slides out from under it rather than being halted.
  motion.vy = 0;
};

/**
 * Land on whatever is under the mech, or keep falling.
 *
 * Leaving the ground by ANY means - jumping, walking off a platform - must
 * clear `grounded`, or the fall animation never plays and a second jump stays
 * available in mid-air.
 */
const resolveGround = (
  motion: PlayerMotion,
  previousY: number,
  collision: WorldCollision,
): void => {
  const surfaceY = collision.surfaceYAt(motion.x, motion.z, previousY);

  if (surfaceY === null || motion.vy > 0 || motion.y > surfaceY) {
    motion.grounded = false;
    return;
  }

  // Only land when arriving from above; a mech that has already dropped past a
  // platform must not be snapped back up onto it.
  if (!collision.canLandOn(previousY, surfaceY)) {
    motion.grounded = false;
    return;
  }

  motion.y = surfaceY;
  motion.vy = 0;
  motion.grounded = true;
};
