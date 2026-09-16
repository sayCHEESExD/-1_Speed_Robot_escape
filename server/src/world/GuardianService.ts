import { GUARDIAN, MOUNT_RADIUS, inGuardianTerritory } from '@robot/shared';
import type { GuardianState } from '../rooms/state/CourseState.js';
import type { PlayerState } from '../rooms/state/PlayerState.js';

/** Shortest signed angle from `from` to `to`. */
const shortestAngle = (from: number, to: number): number => {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
};

/**
 * The guardian, simulated on the server.
 *
 * It is the one hazard in the game that cannot be a pure function of time,
 * because it chases: its position depends on where the players are, which is
 * state. So the SERVER owns it outright - it picks a target from the
 * authoritative positions it already has, moves the guardian, and decides the
 * kill from its own numbers. The client receives x, z, yaw and a charging flag
 * and does nothing but draw them.
 *
 * There is no guardian message. A client cannot move it, cannot claim to have
 * dodged it, and cannot avoid being hit by it.
 */
export class GuardianService {
  /** Seconds of charge still committed to, so it is not twitchy at the edge. */
  private commit = 0;

  /** Which way it is patrolling when nobody is around. */
  private patrolDirection = 1;

  /** Session it is currently chasing, for logging and for hysteresis. */
  private target: string | null = null;

  /** Put it back in the middle of its territory, facing down the course. */
  reset(state: GuardianState): void {
    state.x = 0;
    state.z = (GUARDIAN.minZ + GUARDIAN.maxZ) / 2;
    state.rotationY = Math.PI;
    state.charging = false;
    this.commit = 0;
    this.target = null;
  }

  /**
   * Advance one tick.
   *
   * @param players every connected player, as the server has them
   */
  update(state: GuardianState, delta: number, players: Iterable<PlayerState>): void {
    const dt = Math.max(0, Math.min(delta, 0.25));
    if (dt === 0) return;

    const prey = this.pickTarget(state, players);

    if (prey) {
      this.target = prey.sessionId;
      this.commit = GUARDIAN.commit;
    } else {
      this.commit = Math.max(0, this.commit - dt);
      if (this.commit === 0) this.target = null;
    }

    const charging = prey !== null || this.commit > 0;
    state.charging = charging;

    // Where it wants to be: on the player, or pacing its patrol line.
    let goalX: number;
    let goalZ: number;
    if (prey) {
      goalX = prey.x;
      goalZ = prey.z;
    } else if (charging) {
      // Committed but out of sight: keep going the way it was already facing.
      goalX = state.x + Math.sin(state.rotationY) * 10;
      goalZ = state.z + Math.cos(state.rotationY) * 10;
    } else {
      goalX = 0;
      goalZ = this.patrolDirection > 0 ? GUARDIAN.maxZ : GUARDIAN.minZ;
      if (Math.abs(state.z - goalZ) < 4) this.patrolDirection *= -1;
    }

    const toX = goalX - state.x;
    const toZ = goalZ - state.z;
    const distance = Math.hypot(toX, toZ);
    if (distance > 0.01) {
      // Turn toward the goal at a fixed rate, then walk along the way it is
      // actually facing. Turning and moving independently is what makes a
      // charge readable - it has to commit to a line before it covers ground.
      const desired = Math.atan2(toX, toZ);
      const turn = shortestAngle(state.rotationY, desired);
      const step = GUARDIAN.turnSpeed * dt * (charging ? 1.5 : 1);
      state.rotationY += Math.abs(turn) <= step ? turn : Math.sign(turn) * step;

      const speed = charging ? GUARDIAN.chargeSpeed : GUARDIAN.patrolSpeed;
      state.x += Math.sin(state.rotationY) * speed * dt;
      state.z += Math.cos(state.rotationY) * speed * dt;
    }

    // Kept inside its own territory, so it never wanders into a neighbouring
    // stage and kills someone who never entered the ruins.
    state.x = Math.max(-GUARDIAN.halfWidth, Math.min(GUARDIAN.halfWidth, state.x));
    state.z = Math.max(GUARDIAN.minZ, Math.min(GUARDIAN.maxZ, state.z));
  }

  /**
   * True when this player has been run down.
   *
   * Evaluated on the server tick against the server's own guardian position,
   * so there is nothing for a client to dispute.
   */
  hits(state: GuardianState, player: PlayerState): boolean {
    if (!inGuardianTerritory(player.z)) return false;
    const reach = GUARDIAN.radius + MOUNT_RADIUS;
    if (Math.abs(player.z - state.z) > reach) return false;
    if (Math.abs(player.x - state.x) > reach) return false;
    // Jumping does not save you - it is an guardian, not a rope.
    return player.y < 6;
  }

  /** The nearest player inside its territory and within noticing distance. */
  private pickTarget(
    state: GuardianState,
    players: Iterable<PlayerState>,
  ): PlayerState | null {
    let best: PlayerState | null = null;
    let bestDistance = GUARDIAN.aggroRange;

    for (const player of players) {
      if (!player.ready) continue;
      if (!inGuardianTerritory(player.z)) continue;
      const distance = Math.hypot(player.x - state.x, player.z - state.z);
      // Hysteresis: it keeps its current target a little past the range it
      // would have picked them up at, so two players close together do not
      // make it flip back and forth every tick.
      const range = player.sessionId === this.target ? GUARDIAN.leashRange : bestDistance;
      if (distance > range) continue;
      if (best === null || distance < bestDistance) {
        best = player;
        bestDistance = distance;
      }
    }

    return best;
  }
}
