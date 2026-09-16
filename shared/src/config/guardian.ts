import { COURSE, RUINS_ARENA } from './course.js';

/**
 * The SENTINEL that patrols the wreckage of stage 5.
 *
 * Unlike every other hazard in the game, the sentinel is NOT a pure function
 * of time: it reacts to where the players are, and that is state rather than a
 * formula. So it is simulated by the server and replicated, and the kill is
 * decided on the server tick from the server's own position for it.
 *
 * Its territory is DERIVED from the ruins arena the floor is laid on, rather
 * than authored separately - a sentinel whose patrol range and whose floor
 * disagree is one that walks off the edge of its own stage.
 */
export interface GuardianConfig {
  /** Z range it patrols, inset from the arena's ends. */
  readonly minZ: number;
  readonly maxZ: number;
  /** X range it may wander across, inset from the arena's walls. */
  readonly halfWidth: number;
  /** Height of its shoulder above the floor - it is meant to loom. */
  readonly shoulderY: number;
  /** Body radius used for the kill test. */
  readonly radius: number;
  /** Patrol speed when nobody has been noticed. */
  readonly patrolSpeed: number;
  /** Charge speed once a player is in range. */
  readonly chargeSpeed: number;
  /** How far it can notice a player. */
  readonly aggroRange: number;
  /** How far it will chase before giving up and returning to patrol. */
  readonly leashRange: number;
  /** Turn rate, radians per second. Deliberately ponderous. */
  readonly turnSpeed: number;
  /** Seconds it keeps charging after losing sight, so it is not twitchy. */
  readonly commit: number;
}

/**
 * Inset from the arena edge, so it never grinds along a wall.
 *
 * The arena is deliberately huge; the sentinel using slightly less of it than
 * the player does is what keeps a corner from becoming a safe spot AND keeps
 * the machine off the walls.
 */
const INSET = 8;

export const GUARDIAN: GuardianConfig = {
  minZ: RUINS_ARENA.minZ + INSET * 2,
  maxZ: RUINS_ARENA.maxZ - INSET * 2,
  halfWidth: RUINS_ARENA.halfWidth - INSET,
  shoulderY: COURSE.floorY,
  radius: 5.6,
  patrolSpeed: 9,
  // Faster than before: an arena this size needs a charge that can actually
  // close the distance, or the threat is one the player simply walks away
  // from.
  chargeSpeed: 30,
  aggroRange: 62,
  leashRange: 110,
  turnSpeed: 1.5,
  commit: 1.6,
};

/** True when a position is inside the sentinel's territory. */
export const inGuardianTerritory = (z: number): boolean =>
  z >= RUINS_ARENA.minZ && z <= RUINS_ARENA.maxZ;
