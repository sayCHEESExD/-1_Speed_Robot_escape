import { Schema, type } from '@colyseus/schema';
import { AvatarState } from './AvatarState.js';
import {
  RobotAnimationState,
  INITIAL_OWNED_ROBOTS,
  SPAWN_POSITION,
  SPAWN_ROTATION_Y,
  STARTER_ROBOT_SLOT,
  type RobotAnimationState as AnimationState,
} from '@robot/shared';

/**
 * Replicated per-player state.
 *
 * Every field here is written by the SERVER. Transform and motion come out of
 * the authoritative simulation; progression, Wins and the owned-robot set are
 * written only by their own service. Nothing is ever copied from a client
 * message.
 *
 * Note what is NOT here: bone rotations, robot part transforms, gait timers.
 * Clients reconstruct the whole animation from the compact motion fields.
 */
export class PlayerState extends Schema {
  @type('string') sessionId = '';

  /** The transform of the ROBOT. The rider is carried and has none. */
  @type('float32') x: number = SPAWN_POSITION.x;
  @type('float32') y: number = SPAWN_POSITION.y;
  @type('float32') z: number = SPAWN_POSITION.z;
  @type('float32') rotationY: number = SPAWN_ROTATION_Y;

  /** Horizontal speed, drives the remote gait blend. */
  @type('float32') speed = 0;
  /** Vertical velocity, distinguishes the rising and falling poses. */
  @type('float32') verticalVelocity = 0;
  @type('boolean') grounded = true;

  /** Authoritative velocity, needed by the client to reconcile prediction. */
  @type('float32') velocityX = 0;
  @type('float32') velocityY = 0;
  @type('float32') velocityZ = 0;
  /** Highest input sequence the server has simulated for this player. */
  @type('uint32') lastInputSeq = 0;

  /**
   * LATCHED simulation state, replicated so client reconciliation can restore
   * the FULL authoritative motion before it replays unacknowledged input.
   *
   * Neither is a transform and neither is ever read back from a client. Replay
   * is only correct when it resumes from exactly the state the server was in:
   * `jumpLatched` decides whether the next input counts as a fresh press, and
   * `coyote` decides whether a jump just off a plank lip is still allowed.
   * Restoring position and velocity but not these makes replay derive
   * different jump EDGES than the server took.
   */
  @type('boolean') jumpLatched = false;
  @type('float32') coyote = 0;

  /** Monotonic counts, so a remote client can trigger one-shot animations. */
  @type('uint32') jumpCount = 0;

  @type('uint32') deathCount = 0;

  /**
   * Treadmill the player is standing on, or 0.
   *
   * DERIVED by the simulation from the position the server itself computed.
   * There is no treadmill message, so a client can neither claim a belt it is
   * not on nor keep the bonus after stepping off.
   */
  @type('uint8') treadmill = 0;

  @type('string') animation: AnimationState = RobotAnimationState.Idle;

  /**
   * How this player looks in the Bloxity portal.
   *
   * The ONE part of this schema that originates with a client, and the comment
   * at the top of this file still holds everywhere it matters: this decides
   * nothing. It is sanitised on arrival, it is cosmetic, and no service reads
   * it. See `AvatarState`.
   */
  @type(AvatarState) avatar = new AvatarState();

  /**
   * THE NAME EVERYONE SEES, and the portrait beside it.
   *
   * The portal's display name, replicated so every client can draw every
   * player: a nameplate over a mech, a row on a board, a face in a list. It is
   * EMPTY for a player who is not signed in, and the one place that decides
   * what to show instead is `visibleName` - never a caller's own guess.
   *
   * The internal ids stay where they belong. `sessionId` is the room's own
   * handle for a connection and the Bloxity account id never leaves the
   * server at all; neither is ever drawn.
   */
  @type('string') displayName = '';
  @type('string') avatarUrl = '';

  /** Server-authoritative progression. */
  @type('uint32') level = 1;
  /**
   * Rebirths performed. `uint32`, not `uint16`: the ladder has no end, and at
   * `uint16` rebirth 65536 would wrap to zero and take the level cap with it.
   */
  @type('uint32') rebirths = 0;
  /** Stage wins. Awarded by StageService only - never read from a client. */
  @type('uint32') wins = 0;
  /** Lifetime farmed Speed. Awarded by SpeedService only. Drives level. */
  @type('float64') totalSpeed = 0;

  /** Equipped robot slot - the best one owned. Written by RobotService. */
  @type('uint8') robotSlot = STARTER_ROBOT_SLOT;
  /** Bitmask of robots claimed. Written by RobotService only. */
  @type('uint32') ownedRobots = INITIAL_OWNED_ROBOTS;
  /**
   * Speed granted per SECOND and per stride by the equipped robot.
   *
   * One figure for both, because idling, walking and running a treadmill are
   * deliberately one economy. The HUD prints it as the "+N Speed" over the
   * player's head and the display signs print the same number.
   */
  @type('float32') speedPerStep = 1;

  /**
   * Authoritative movement multiplier and jump velocity, resolved from level,
   * rebirth and the equipped robot by the one shared formula. The client
   * moves at exactly these - it never derives its own.
   */
  @type('float32') moveMultiplier = 1;
  @type('float32') jumpVelocity = 30;

  /**
   * Level cap for the current rebirth. `uint32`, for the same reason as
   * `rebirths`.
   */
  @type('uint32') maxLevel = 50;

  /** Highest stage (1-based) ever banked. 0 before the first finish. */
  @type('uint32') bestStage = 0;

  /**
   * Trails. Written ONLY by TrailService; a client sends a slot number to buy
   * or equip and never a cost or a multiplier, so there is no figure in a
   * message to forge.
   *
   * A trail multiplies actual MOVEMENT SPEED, and it does so by feeding the
   * one shared movement formula - never a calculation of its own.
   */
  @type('uint16') ownedTrails = 0;
  @type('uint8') trailSlot = 0;

  /** True once the server has simulated at least one input for this player. */
  @type('boolean') ready = false;
}
