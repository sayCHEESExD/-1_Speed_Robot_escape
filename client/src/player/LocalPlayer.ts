import {
  MOVEMENT,
  WorldCollision,
  copyMotion,
  createMotion,
  createSimEvents,
  horizontalSpeed,
  resetMotion,
  stepPlayer,
  type RobotAnimationState,
  type MoveMessage,
  type MovementInput,
  type PlayerMotion,
  type SimParams,
} from '@robot/shared';
import { Vector3 } from 'three';
import { createAnimationInput, type AnimationInput } from '../animation/AnimationInput.js';
import { DEATH } from '../config/animationConfig.js';
import type { InputState } from '../input/InputState.js';
import { Mount } from './Mount.js';

/** Inputs kept for re-simulation. Older ones are dropped as the server acks. */
const MAX_PENDING_INPUTS = 240;

/**
 * Fixed simulation timestep, in seconds.
 *
 * The client steps - and SENDS - at exactly this cadence regardless of render
 * frame rate. That matters for authority: every simulated step has to reach
 * the server, or the server falls behind and its authoritative position lags
 * the player's. A fixed step also bounds the message rate on a high-refresh
 * display and makes the two simulations bit-comparable.
 */
const FIXED_DT = 1 / 60;

/** Most steps one render frame may run, so a stall cannot spiral. */
const MAX_STEPS_PER_FRAME = 5;

/** Seconds the arrival pop plays after the mount is placed. */
const ARRIVE_DURATION = 0.16;

/**
 * Longest the client will ignore authoritative state after predicting a death.
 *
 * A FAILSAFE, not the mechanism - the barrier is normally lifted by the
 * server's own Respawn message. It exists for the case that never gets one:
 * a death the client predicted and the server did not agree with, where the
 * prediction has to be corrected back.
 */
const RESPAWN_ACK_TIMEOUT = 1.5;

/**
 * Seconds a finished death waits for a placement before asking again.
 *
 * The bug this exists to close: a death here is a PREDICTION, and the freeze
 * it starts is only ever lifted by an authoritative placement. When the server
 * disagreed - the client thought it had clipped a hazard, the server's own
 * simulation had it land safely - no `Respawn` was ever sent, nothing reset
 * `deathTime`, and the mount sat at the end of its fall-over animation for
 * ever with no way back.
 *
 * The barrier already had a timeout, but that only let RECONCILIATION resume;
 * the death freeze itself had no terminal state at all, so the player stayed
 * frozen while their position was quietly corrected underneath them.
 *
 * So a stuck death now asks. The server is still the only thing that places
 * anyone - it answers `RequestRespawn` by putting them at the spawn, exactly
 * as any other death does - and the ask repeats until it is answered, which is
 * what makes completing the flow a guarantee rather than a hope.
 */
const RESPAWN_NUDGE_INTERVAL = 0.75;

/**
 * Position error above which prediction snaps instead of easing.
 *
 * Small corrections are blended into the render position so ordinary
 * disagreement is invisible; a large one means the server did something the
 * client could not predict - a respawn, a refused input - and should be shown
 * immediately rather than slid to.
 */
const SNAP_DISTANCE = 5;

/** How quickly a small correction is eased away, per second. */
const CORRECTION_RATE = 14;

const lerp = (from: number, to: number, alpha: number): number =>
  from + (to - from) * alpha;

/** Shared empty result, so a quiet frame allocates nothing. */
const EMPTY_INPUTS: MoveMessage[] = [];

/**
 * How the player last arrived somewhere they did not ride to.
 *
 * `respawn` is a deliberate reset of the run; `correction` is the server
 * disagreeing with prediction. Both skip the camera's smoothing, but only a
 * respawn is allowed to be seen.
 */
export type PlacementKind = 'none' | 'respawn' | 'correction';

/** One unacknowledged input, kept so it can be replayed after a correction. */
interface PendingInput {
  seq: number;
  dt: number;
  input: MovementInput;
}

/**
 * The authoritative fields the client reconciles against.
 *
 * This must cover EVERY field of `PlayerMotion`, not just the visible ones.
 * Replay re-runs `stepPlayer`, which reads latched state - the jump edge and
 * the coyote window - as well as the transform. Restore a partial state and
 * replay takes different decisions than the server did, which is divergence
 * the correction offset then has to hide.
 */
export interface AuthoritativeMotion {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  grounded: boolean;
  jumpCount: number;
  lastInputSeq: number;
  jumpLatched: boolean;
  coyote: number;
}

/**
 * The locally controlled mount: a PREDICTION of a server-owned simulation.
 *
 * The server is authoritative. This runs the identical `stepPlayer` from
 * shared so the robot responds instantly, keeps every input the server has
 * not acknowledged, and on each server update snaps to the authoritative state
 * and replays those inputs. Because both sides run the same function, replay
 * converges instead of fighting.
 *
 * Nothing here writes a transform to the network - the only thing sent is the
 * input that produced this frame.
 */
export class LocalPlayer {
  readonly mount: Mount;

  /**
   * RENDER position: the simulated state interpolated to this exact frame and
   * carrying the reconciliation offset.
   *
   * The camera and the world triggers both read this rather than the raw
   * simulation, because the raw simulation only advances on 60Hz boundaries.
   * On a 144Hz display most frames advance it by nothing and every third frame
   * by a whole step, which is a stutter the camera would faithfully reproduce.
   */
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  /** Simulation state one step behind, for render interpolation. */
  private readonly previous = { x: 0, y: 0, z: 0 };

  private readonly motion: PlayerMotion = createMotion();
  private readonly events = createSimEvents();
  private readonly replayEvents = createSimEvents();
  private readonly collision: WorldCollision;
  private readonly params: SimParams = {
    moveMultiplier: 1,
    jumpVelocity: MOVEMENT.jumpVelocity,
    time: 0,
  };

  private readonly pending: PendingInput[] = [];
  private nextSeq = 1;
  /** Inputs simulated but not yet handed to the network. */
  private readonly outgoing: MoveMessage[] = [];
  /** Leftover render time not yet consumed by a fixed step. */
  private accumulator = 0;

  /** Render-space offset that eases a small correction away. */
  private readonly correction = new Vector3();

  /** How the player was last PLACED, cleared when read. */
  private placement: PlacementKind = 'none';

  /**
   * Seconds into the death animation, or -1 when alive.
   *
   * While this runs the simulation does not step and NO steering is emitted,
   * so the player cannot drift, fall further, or be moved by anything they
   * press. It is the local death transition the whole stale-state fix hangs
   * on.
   */
  private deathTime = -1;

  /** Seconds into the arrival pop, or -1 when not arriving. */
  private arriveTime = -1;

  /**
   * True from predicting a death until the server acknowledges it.
   *
   * Between those two moments every state patch still in flight describes the
   * player as they were an instant BEFORE they died - alive, mid-air over the
   * gap - and applying one teleports them back there for a frame. Locally that
   * window is under a frame and invisible; over a real connection it is a
   * whole round trip.
   */
  private awaitingRespawn = false;
  private respawnWait = 0;

  /**
   * Seconds since the death animation finished with nobody placing us.
   *
   * -1 while there is nothing to wait for. Counts only AFTER the animation is
   * over, so a slow connection is never nagged mid-fall.
   */
  private stuckTime = -1;

  /** Steering this frame, for the robot's head turn. */
  private turnSignal = 0;

  private readonly animationInput: AnimationInput = createAnimationInput();

  constructor(collision: WorldCollision, robotSlot: number) {
    this.collision = collision;
    this.mount = new Mount(robotSlot);
    this.previous.x = this.motion.x;
    this.previous.y = this.motion.y;
    this.previous.z = this.motion.z;
    this.syncFromMotion();
    this.syncMount();
  }

  get horizontalSpeed(): number {
    return horizontalSpeed(this.motion);
  }

  get rotationY(): number {
    return this.motion.yaw;
  }

  get isGrounded(): boolean {
    return this.motion.grounded;
  }

  /** True on the frame the mount touched down. */
  get justLanded(): boolean {
    return this.events.landed;
  }

  /** True on the frame the mount left the ground. */
  get justJumped(): boolean {
    return this.events.jumpStarted;
  }

  get animationState(): RobotAnimationState {
    return this.mount.animationState;
  }

  /**
   * Take the inputs simulated since the last call.
   *
   * Every one must be sent: the server advances only by the inputs it
   * receives, so a dropped input is authoritative movement that never happens.
   */
  drainOutgoing(): MoveMessage[] {
    if (this.outgoing.length === 0) return EMPTY_INPUTS;
    const batch = this.outgoing.slice();
    this.outgoing.length = 0;
    return batch;
  }

  get movementMultiplier(): number {
    return this.params.moveMultiplier;
  }

  /** Actual run speed in world units per second. */
  get maxRunSpeed(): number {
    return MOVEMENT.moveSpeed * this.params.moveMultiplier;
  }

  /**
   * Apply the server's movement profile.
   *
   * Resolved server-side from level, rebirth and the equipped robot;
   * prediction uses it so the client simulates at exactly the authoritative
   * speed and never derives its own.
   */
  setMovementProfile(
    multiplier: number,
    jumpVelocity: number,
  ): void {
    if (Number.isFinite(multiplier) && multiplier > 0) {
      this.params.moveMultiplier = multiplier;
    }
    if (Number.isFinite(jumpVelocity) && jumpVelocity > 0) {
      this.params.jumpVelocity = jumpVelocity;
    }
  }

  /** Show the robot the server says this player is riding. Cosmetic only. */
  setRobotSlot(slot: number): void {
    this.mount.setRobotSlot(slot);
  }

  /** Show the trail the server says this player is wearing. Cosmetic only. */
  setTrailSlot(slot: number): void {
    this.mount.setTrailSlot(slot);
  }

  /**
   * The world clock the simulation steps against.
   *
   * Estimated from the replicated `elapsed` plus however long ago that patch
   * arrived. Sinking platforms and rolling balls are pure functions of it, so
   * a client that guesses slightly wrong simply mispredicts a landing and is
   * corrected - exactly like any other prediction.
   */
  setWorldTime(time: number): void {
    if (Number.isFinite(time)) this.params.time = time;
  }

  /** True while the mount is standing on a treadmill belt. */
  get onTreadmill(): boolean {
    return this.motion.treadmill > 0;
  }

  /**
   * Snap the prediction to an authoritative transform.
   *
   * Used for a server respawn: pending inputs are abandoned because they
   * described a run that no longer exists.
   */
  teleport(x: number, y: number, z: number, rotationY: number): void {
    resetMotion(this.motion, x, y, z, rotationY);
    this.previous.x = x;
    this.previous.y = y;
    this.previous.z = z;
    this.pending.length = 0;
    // Anything still queued for the network describes the run that just ended.
    // Sending it would advance the server from a position the player has
    // already left.
    this.outgoing.length = 0;
    this.accumulator = 0;
    this.correction.set(0, 0, 0);
    this.placement = 'respawn';
    this.deathTime = -1;
    // Placed. Whatever the death was waiting for has happened.
    this.stuckTime = -1;
    this.arriveTime = 0;
    this.mount.resetAnimation();
    this.mount.setVisualScale(0.15, 0.15, 0.15);
    this.syncFromMotion();
    this.syncMount();
  }

  /**
   * Enter the local death transition.
   *
   * Everything describing the run just ended is dropped HERE, at the moment of
   * death, rather than when the server gets round to confirming it: the
   * unacknowledged inputs, the queued outgoing ones, the reconciliation offset
   * and the velocity. The simulation then stops stepping until the player is
   * placed, so no later frame can advance the old state.
   */
  beginDeath(): void {
    if (this.deathTime >= 0) return;
    this.deathTime = 0;
    this.arriveTime = -1;
    this.awaitingRespawn = true;
    this.respawnWait = 0;
    this.stuckTime = -1;
    this.pending.length = 0;
    this.outgoing.length = 0;
    this.correction.set(0, 0, 0);
    this.accumulator = 0;
    this.motion.vx = 0;
    this.motion.vy = 0;
    this.motion.vz = 0;
  }

  /** True while the death animation is playing. */
  get isDying(): boolean {
    return this.deathTime >= 0;
  }

  /** True once the death has run its course and the player may be placed. */
  get deathComplete(): boolean {
    return this.deathTime >= DEATH.duration;
  }

  /**
   * True when this death has been waiting too long to be placed.
   *
   * CONSUMES the wait, so a caller that asks every frame sends one request per
   * interval rather than one per frame. Returning it rather than sending
   * anything keeps this class free of the network, which is the same reason
   * the death prediction does not decide the respawn either.
   */
  consumeRespawnNudge(): boolean {
    if (this.stuckTime < RESPAWN_NUDGE_INTERVAL) return false;
    this.stuckTime = 0;
    return true;
  }

  /**
   * The server has confirmed the respawn; stale patches can no longer arrive.
   *
   * Called from the Respawn handler, which is ordered on the same socket as
   * the state patches - so everything the server sends after it is
   * post-respawn by construction.
   */
  acknowledgeRespawn(): void {
    this.awaitingRespawn = false;
    this.respawnWait = 0;
  }

  /**
   * Reconcile against the server's authoritative state.
   *
   * Snaps to what the server simulated, discards inputs it has already
   * consumed, and replays the rest so the prediction lands back where the
   * player expects to be.
   */
  reconcile(state: AuthoritativeMotion): void {
    // The barrier. Until the server confirms the respawn, its state still
    // describes the player alive at the place they died - applying it is
    // exactly the stale replay this guards against.
    if (this.awaitingRespawn) return;

    const predictedX = this.motion.x;
    const predictedY = this.motion.y;
    const predictedZ = this.motion.z;

    this.motion.x = state.x;
    this.motion.y = state.y;
    this.motion.z = state.z;
    this.motion.vx = state.velocityX;
    this.motion.vy = state.velocityY;
    this.motion.vz = state.velocityZ;
    this.motion.yaw = state.rotationY;
    this.motion.grounded = state.grounded;
    this.motion.jumpCount = state.jumpCount;
    // The latched half. Without these two the replay below re-derives its own
    // jump edges from whatever the prediction happened to be holding, so a
    // pending jump could fire twice or not at all. They cost a few bytes a
    // patch and make replay bit-exact.
    this.motion.jumpLatched = state.jumpLatched;
    this.motion.coyote = state.coyote;

    // Drop everything the server has already simulated, then replay the rest.
    let kept = 0;
    for (const entry of this.pending) {
      if (entry.seq <= state.lastInputSeq) continue;
      this.pending[kept] = entry;
      kept += 1;
    }
    this.pending.length = kept;

    for (const entry of this.pending) {
      stepPlayer(
        this.motion,
        entry.input,
        this.params,
        entry.dt,
        this.collision,
        this.replayEvents,
      );
    }

    // Carry the visible difference as an offset and ease it away, so a small
    // correction does not read as a teleport.
    const dx = predictedX - this.motion.x;
    const dy = predictedY - this.motion.y;
    const dz = predictedZ - this.motion.z;
    const snapped = Math.hypot(dx, dy, dz) > SNAP_DISTANCE;
    this.correction.set(snapped ? 0 : dx, snapped ? 0 : dy, snapped ? 0 : dz);

    // The interpolation baseline is deliberately NOT collapsed onto the
    // replayed state. Replay re-runs the same inputs the client already ran,
    // so `previous` is still one step behind and interpolation stays
    // continuous; any real divergence is carried by `correction`, which eases.
    // Collapsing it here would re-base the blend twenty times a second, and
    // every one of those is a visible tick in the follow.
    //
    // A SNAP is the exception: the server put the player somewhere the client
    // never simulated, so there is no earlier state worth blending from.
    if (snapped) {
      this.previous.x = this.motion.x;
      this.previous.y = this.motion.y;
      this.previous.z = this.motion.z;
      // Reported as a CORRECTION, not a respawn: it must arrive invisibly. A
      // respawn already pending is not downgraded - the dolly belongs to the
      // respawn that is still on its way to being drawn.
      if (this.placement === 'none') this.placement = 'correction';
    }

    this.syncFromMotion();
    this.syncMount();
  }

  /**
   * Advance the prediction and record the inputs for the server.
   *
   * Simulation runs on a FIXED timestep so client and server take identical
   * steps; a render frame may therefore produce zero, one or several inputs.
   * Animation is still updated once per render frame with the real delta.
   */
  update(delta: number, input: Readonly<InputState>, cameraYaw: number): void {
    this.tickRespawnBarrier(delta);

    if (this.deathTime >= 0) {
      // Frozen. No step, no steering emitted, no gravity - the old state
      // cannot advance and nothing the player presses can move a dead mount.
      this.deathTime += delta;
      // Only once the fall-over has actually finished: until then there is
      // nothing wrong, just an animation playing.
      if (this.deathTime >= DEATH.duration) {
        this.stuckTime = this.stuckTime < 0 ? 0 : this.stuckTime + delta;
      }
      // The LOCAL simulation is frozen, but the server's must not be: it
      // advances only by the inputs it receives, and a FALL is confirmed by
      // the server watching its own player cross the death plane. Going silent
      // here would mean a fall that is never acknowledged and a barrier only
      // the failsafe ever lifts. Neutral input: no stick, no jump.
      this.emitIdleInputs(delta);
      this.updateAnimation(delta, true);
      return;
    }

    this.accumulator += Math.max(0, delta);
    this.turnSignal = input.moveX;

    let steps = 0;
    let jumpStarted = false;
    let landed = false;

    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_DT;
      steps += 1;

      const movement: MovementInput = {
        moveX: input.moveX,
        moveZ: input.moveZ,
        jump: input.jump,
        cameraYaw,
      };

      const seq = this.nextSeq;
      this.nextSeq += 1;

      // Remember where the step started so the frame can be rendered part-way
      // between two simulation states instead of snapping between them.
      this.previous.x = this.motion.x;
      this.previous.y = this.motion.y;
      this.previous.z = this.motion.z;

      stepPlayer(this.motion, movement, this.params, FIXED_DT, this.collision, this.events);

      // Edges from every substep must survive to the animator, or a jump that
      // happened in an early substep would be silently dropped.
      jumpStarted = jumpStarted || this.events.jumpStarted;
      landed = landed || this.events.landed;

      this.pending.push({ seq, dt: FIXED_DT, input: movement });
      if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();

      this.outgoing.push({
        seq,
        dt: FIXED_DT,
        moveX: movement.moveX,
        moveZ: movement.moveZ,
        jump: movement.jump,
        cameraYaw,
      });
    }

    // A long stall would otherwise leave a huge backlog to chew through.
    if (this.accumulator > FIXED_DT * MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.events.jumpStarted = jumpStarted;
    this.events.landed = landed;

    this.advanceArrival(delta);
    this.decayCorrection(delta);
    this.syncFromMotion();
    this.syncMount();
    this.updateAnimation(delta, false);

    // The ribbon is emitted from the RENDERED position, and a player running
    // on a treadmill lays none: they are not going anywhere.
    this.mount.updateEffects(
      delta,
      this.position.x,
      this.position.y,
      this.position.z,
      this.onTreadmill ? 0 : this.horizontalSpeed,
    );
  }

  /**
   * How the player was placed since this was last called, if at all.
   *
   * Reading CLEARS it, so exactly one frame reacts to a given placement.
   */
  consumePlacement(): PlacementKind {
    const kind = this.placement;
    this.placement = 'none';
    return kind;
  }

  /** Copy the predicted motion out, for diagnostics. */
  readMotion(into: PlayerMotion): void {
    copyMotion(this.motion, into);
  }

  /** Pop back to full size after being placed. */
  private advanceArrival(delta: number): void {
    if (this.arriveTime < 0) return;
    this.arriveTime += delta;
    const t = Math.min(this.arriveTime / ARRIVE_DURATION, 1);
    if (t >= 1) {
      this.arriveTime = -1;
      this.mount.setVisualScale(1, 1, 1);
      return;
    }
    // Ease out with a touch of overshoot, so arriving reads as landing rather
    // than fading in.
    const scale = 0.15 + 0.85 * t * (2 - t) + 0.08 * Math.sin(t * Math.PI);
    this.mount.setVisualScale(scale, scale, scale);
  }

  /**
   * Emit input without simulating it.
   *
   * Used only while dead. The sequence keeps advancing and the server keeps
   * stepping, but nothing touches this client's own motion or its pending
   * list - so there is no local state to replay and nothing to reconcile
   * against until the respawn lands.
   */
  private emitIdleInputs(delta: number): void {
    this.accumulator += Math.max(0, delta);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_DT;
      steps += 1;
      this.outgoing.push({
        seq: this.nextSeq,
        dt: FIXED_DT,
        moveX: 0,
        moveZ: 0,
        jump: false,
        cameraYaw: this.motion.yaw,
      });
      this.nextSeq += 1;
    }
    if (this.accumulator > FIXED_DT * MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  /** Lift the barrier if the server never acknowledged the death. */
  private tickRespawnBarrier(delta: number): void {
    if (!this.awaitingRespawn) return;
    this.respawnWait += delta;
    if (this.respawnWait < RESPAWN_ACK_TIMEOUT) return;
    // No Respawn message came, so the prediction was wrong and reconciliation
    // must be allowed to correct it.
    this.awaitingRespawn = false;
    this.respawnWait = 0;
  }

  /** Ease the render-space correction offset back to zero. */
  private decayCorrection(delta: number): void {
    if (this.correction.lengthSq() < 1e-8) {
      this.correction.set(0, 0, 0);
      return;
    }
    this.correction.multiplyScalar(Math.exp(-CORRECTION_RATE * delta));
  }

  /**
   * Resolve the render transform for this frame.
   *
   * `alpha` is how far the leftover accumulator has carried us into the NEXT
   * simulation step, so blending the previous state toward the current one by
   * it produces continuous motion at any refresh rate. The eased
   * reconciliation offset is folded in here too, so exactly one transform
   * exists for the camera, the mount and the triggers to agree on.
   */
  private syncFromMotion(): void {
    const alpha = Math.min(Math.max(this.accumulator / FIXED_DT, 0), 1);
    this.position.set(
      lerp(this.previous.x, this.motion.x, alpha) + this.correction.x,
      lerp(this.previous.y, this.motion.y, alpha) + this.correction.y,
      lerp(this.previous.z, this.motion.z, alpha) + this.correction.z,
    );
    this.velocity.set(this.motion.vx, this.motion.vy, this.motion.vz);
  }

  private updateAnimation(delta: number, dying: boolean): void {
    this.animationInput.grounded = this.motion.grounded;
    // A player on a treadmill has zero velocity by design, so the animator is
    // handed the speed they are RUNNING at rather than the speed they are
    // travelling at. This is the one place the two differ.
    this.animationInput.horizontalSpeed = this.onTreadmill
      ? this.maxRunSpeed
      : this.horizontalSpeed;
    this.animationInput.moveMultiplier = this.params.moveMultiplier;
    this.animationInput.verticalVelocity = this.motion.vy;
    this.animationInput.turn = dying ? 0 : this.turnSignal;
    this.animationInput.jumpStarted = !dying && this.events.jumpStarted;
    this.animationInput.landed = !dying && this.events.landed;
    this.animationInput.dying = dying;
    this.mount.update(delta, this.animationInput);
  }

  private syncMount(): void {
    // ONE render transform, already interpolated and already carrying the
    // eased correction. The camera follows the very same vector, so a
    // correction can never slide the mount within the frame.
    this.mount.setPosition(this.position.x, this.position.y, this.position.z);
    this.mount.setYaw(this.motion.yaw);
  }
}
