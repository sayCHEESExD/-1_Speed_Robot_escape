import {
  MAX_SIM_DELTA,
  WorldCollision,
  copyMotion,
  createMotion,
  createSimEvents,
  horizontalSpeed,
  resetMotion,
  sanitiseInput,
  stepPlayer,
  type MoveMessage,
  type PlayerMotion,
  type SimEvents,
} from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';

/**
 * Simulated seconds a client may bank per real second.
 *
 * Inputs carry their own delta so a laggy client can catch up, but the total
 * must stay near real time - otherwise a client could send a thousand inputs
 * at once and sprint across the whole course. 1.5 leaves generous room for
 * jitter and frame-rate spikes while making sustained speed-hacking
 * impossible.
 */
const MAX_TIME_BUDGET_RATIO = 1.5;

/** Seconds of simulated time a fresh client starts with, to absorb bursts. */
const INITIAL_BUDGET = 0.5;

/**
 * Largest jump in sequence number the server will follow.
 *
 * Sequence numbers only ever advance by one per simulated step, so a jump of
 * thousands is either corruption or an attempt to poison the high-water mark:
 * accepting it would make every subsequent honest input look stale and wedge
 * the player's movement permanently. Such inputs are dropped WITHOUT moving
 * `lastSeq`, so normal play continues.
 */
const MAX_SEQ_JUMP = 600;

/** Why an input was refused. */
export type RejectReason = 'malformed' | 'stale-seq' | 'seq-jump' | 'budget';

/** Per-session simulation state the server owns outright. */
interface Sim {
  motion: PlayerMotion;
  events: SimEvents;
  /** Highest input sequence consumed. */
  lastSeq: number;
  /** Simulated seconds still allowed. */
  budget: number;
  /** Wall clock of the last budget top-up. */
  lastRefill: number;
}

/**
 * Server-authoritative movement.
 *
 * The client sends INPUT and nothing else; this runs the shared simulation and
 * the result becomes the player's position, velocity, rotation, grounded and
 * jump state. Because the very same `stepPlayer` runs on the client for
 * prediction, the two agree by construction rather than by trust.
 *
 * Everything a cheating client might want to assert - where it is, how fast it
 * is going, whether it may jump - is decided here from state the client cannot
 * reach.
 */
export class MovementService {
  private readonly sims = new Map<string, Sim>();
  readonly collision = new WorldCollision();

  /** Reason the last input was refused, for logging. */
  private lastReject: RejectReason | null = null;

  /** Seconds of simulation the last accepted input advanced. */
  private lastStepSeconds = 0;

  /**
   * Did the last accepted input ask to go FORWARD?
   *
   * Read from the input the server itself sanitised, never from a flag the
   * client set: it is the same `moveZ` the simulation steered with, so "was
   * the player walking forward" and "did the player move forward" cannot
   * disagree. Speed is paid for exactly this, so it belongs beside the step it
   * came from.
   */
  private lastForward = false;

  initialise(player: PlayerState): void {
    const sim: Sim = {
      motion: createMotion(),
      events: createSimEvents(),
      lastSeq: 0,
      budget: INITIAL_BUDGET,
      lastRefill: Date.now(),
    };
    this.sims.set(player.sessionId, sim);
    this.publish(player, sim);
  }

  forget(sessionId: string): void {
    this.sims.delete(sessionId);
  }

  /** Authoritative motion for a session, for services that need to read it. */
  motionOf(sessionId: string): PlayerMotion | undefined {
    return this.sims.get(sessionId)?.motion;
  }

  /** Why the last `applyInput` returned false. */
  get rejectReason(): RejectReason | null {
    return this.lastReject;
  }

  /** Seconds the last accepted input advanced the simulation. */
  get lastStep(): number {
    return this.lastStepSeconds;
  }

  /** True when the last accepted input carried forward intent. */
  get lastDroveForward(): boolean {
    return this.lastForward;
  }

  /**
   * Teleport authoritatively, e.g. on respawn.
   *
   * Only the server calls this - there is no message that lets a client
   * request a position.
   */
  teleport(
    sessionId: string,
    player: PlayerState,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void {
    const sim = this.sims.get(sessionId);
    if (!sim) return;
    resetMotion(sim.motion, x, y, z, yaw);
    this.publish(player, sim);
  }

  /**
   * Consume one input and advance the authoritative simulation.
   *
   * @returns true when the input was simulated
   */
  applyInput(
    sessionId: string,
    player: PlayerState,
    message: MoveMessage,
    time: number,
  ): boolean {
    this.lastReject = null;
    const sim = this.sims.get(sessionId);
    if (!sim) return false;

    const seq = message?.seq;
    const dt = message?.dt;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      this.lastReject = 'malformed';
      return false;
    }
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      this.lastReject = 'malformed';
      return false;
    }

    // Replayed or out-of-order inputs are dropped rather than re-simulated.
    if (seq <= sim.lastSeq) {
      this.lastReject = 'stale-seq';
      return false;
    }

    // A wild jump forward must not become the new high-water mark.
    if (seq > sim.lastSeq + MAX_SEQ_JUMP) {
      this.lastReject = 'seq-jump';
      return false;
    }

    const step = Math.min(dt, MAX_SIM_DELTA);
    this.refill(sim);
    if (step > sim.budget) {
      // More simulated time than has actually elapsed. Deliberately does NOT
      // acknowledge the input: the client keeps it pending and replays it, so
      // a throttled burst is delayed rather than silently swallowed.
      this.lastReject = 'budget';
      return false;
    }
    sim.budget -= step;
    sim.lastSeq = seq;
    this.lastStepSeconds = step;

    const input = sanitiseInput(message);
    // Forward is +Z in camera space, which is the W key and a stick pushed up.
    // Strafing and reversing are movement but they are not forward, and Speed
    // is paid for going forward.
    this.lastForward = input.moveZ > 0;

    stepPlayer(
      sim.motion,
      input,
      {
        moveMultiplier: player.moveMultiplier,
        jumpVelocity: player.jumpVelocity,
        // The SERVER's clock. Sinking platforms and rolling balls are pure
        // functions of it, so the authoritative step is evaluated against the
        // authoritative instant.
        time,
      },
      step,
      this.collision,
      sim.events,
    );

    this.publish(player, sim);
    return true;
  }

  /** Copy the simulation onto the replicated state. */
  private publish(player: PlayerState, sim: Sim): void {
    const m = sim.motion;
    player.x = m.x;
    player.y = m.y;
    player.z = m.z;
    player.rotationY = m.yaw;
    player.velocityX = m.vx;
    player.velocityY = m.vy;
    player.velocityZ = m.vz;
    player.verticalVelocity = m.vy;
    player.speed = horizontalSpeed(m);
    player.grounded = m.grounded;
    player.jumpCount = m.jumpCount;
    // The latched half of the simulation. Replicated for one reason only: the
    // client cannot replay its pending input correctly without resuming from
    // the same edge state the server stopped at.
    player.jumpLatched = m.jumpLatched;
    player.coyote = m.coyote;
    // Derived by the simulation from the position the server computed.
    player.treadmill = m.treadmill;
    player.lastInputSeq = sim.lastSeq;
    player.ready = true;
  }

  /** Top the time budget back up toward real elapsed time. */
  private refill(sim: Sim): void {
    const now = Date.now();
    const elapsed = Math.max(0, (now - sim.lastRefill) / 1000);
    sim.lastRefill = now;
    sim.budget = Math.min(
      sim.budget + elapsed * MAX_TIME_BUDGET_RATIO,
      MAX_SIM_DELTA * 20,
    );
  }

  /** Snapshot motion into a scratch object, for callers that need a copy. */
  snapshot(sessionId: string, into: PlayerMotion): boolean {
    const sim = this.sims.get(sessionId);
    if (!sim) return false;
    copyMotion(sim.motion, into);
    return true;
  }
}
