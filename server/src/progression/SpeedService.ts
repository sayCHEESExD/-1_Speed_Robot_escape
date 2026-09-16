import {
  MAX_SIM_DELTA,
  SPEED,
  earnsSpeed,
  robotForSlot,
  maxLevelForRebirth,
  resolveLevel,
  resolveMovementProfile,
  speedForNextLevel,
  speedGainPerSecond,
  trailMultiplier,
  type MovementProfile,
} from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';

/** What the server remembers between two simulated steps for one player. */
interface Tracker {
  x: number;
  z: number;
  /**
   * Seconds of QUALIFYING movement banked toward the next Speed tick.
   *
   * Speed is paid in whole ticks (`SPEED.grantInterval`), so the odd fractions
   * of a second between two inputs have to be remembered somewhere rather than
   * paid out or thrown away. Movement that does not qualify never reaches
   * here, so a player who walks for half a second and then stands still keeps
   * that half second until they walk again - they are simply not paid for it.
   */
  banked: number;
  /** True until the first step is credited, so spawning pays nothing. */
  fresh: boolean;
}

/** Outcome of crediting one movement step. */
export interface SpeedGain {
  /** Speed added by this step. */
  readonly gained: number;
  /** Levels crossed, if any. */
  readonly levelsGained: number;
}

/**
 * Server authority over Speed farming and levelling.
 *
 * THE ONE PLACE SPEED IS EVER GRANTED, and it grants it for exactly one thing:
 * walking forward. `earnsSpeed` decides whether a step counts and
 * `speedGainPerSecond` decides what it is worth, both in shared config, so the
 * rule and the rate each have a single definition.
 *
 * What the server measures is its OWN simulated step - the distance between
 * two authoritative positions and the forward intent the client sent - never a
 * figure a client chose. Standing still pays nothing, a teleport pays nothing,
 * and holding W against a wall pays nothing, because in none of those cases
 * does the authoritative position move.
 *
 * Level then drives movement speed through the one shared formula, which is
 * the whole loop - walk to farm Speed, gain levels, get faster, clear the
 * gaps that were out of reach.
 */
export class SpeedService {
  private readonly trackers = new Map<string, Tracker>();

  initialise(player: PlayerState): void {
    player.level = 1;
    player.maxLevel = this.levelCap(player);
    this.syncDerived(player);
    this.reset(player.sessionId, player);
  }

  forget(sessionId: string): void {
    this.trackers.delete(sessionId);
  }

  /**
   * Drop the movement baseline.
   *
   * Called on every respawn: the teleport back to the arena is a huge
   * position delta that must never be credited as distance travelled.
   */
  reset(sessionId: string, player: PlayerState): void {
    this.trackers.set(sessionId, {
      x: player.x,
      z: player.z,
      banked: 0,
      fresh: true,
    });
  }

  /**
   * Credit one simulated step and apply any level-ups.
   *
   * Call AFTER the transform has been updated, so the distance measured is the
   * one the server just simulated rather than the one the client claimed.
   *
   * @param forward true when the client asked to go FORWARD this step (W)
   */
  credit(
    sessionId: string,
    player: PlayerState,
    stepSeconds: number,
    forward: boolean,
  ): SpeedGain {
    const tracker = this.trackers.get(sessionId);
    if (!tracker) {
      this.reset(sessionId, player);
      return { gained: 0, levelsGained: 0 };
    }

    /*
     * THE RATE, and it is fixed for as long as these three things are.
     *
     * Robot x rebirth x trail, through the one shared formula. It is also
     * replicated as `speedPerStep`, so the HUD advertises exactly the figure
     * the server is paying rather than a second estimate of it.
     */
    const rate = speedGainPerSecond(
      robotForSlot(player.robotSlot).speedPerSecond,
      player.rebirths,
      player.trailSlot,
      player.ownedTrails,
    );
    player.speedPerStep = rate;

    const step = Number.isFinite(stepSeconds)
      ? Math.max(0, Math.min(stepSeconds, MAX_SIM_DELTA))
      : 0;

    const distance = Math.hypot(player.x - tracker.x, player.z - tracker.z);

    /*
     * The one judgement, and it lives in shared config.
     *
     * A fresh tracker has no previous position to measure against, so the
     * first step after a spawn or a respawn never pays - the teleport that put
     * the player there is not travel.
     */
    const earning =
      !tracker.fresh &&
      earnsSpeed({
        forward,
        distance,
        seconds: step,
        maxDistance: this.maxCreditedStep(player, step),
        /*
         * THE BELT, and leaving this out is how the bay stops paying.
         *
         * A mech running on a treadmill covers no ground by design, so without
         * this every belt fails the "did it actually move" test and a player
         * pounding away on one earns nothing at all. The flag is the SERVER's
         * own - derived by its simulation from the position it computed.
         */
        onTreadmill: player.treadmill > 0,
      });

    /*
     * THE PAYMENT, and it comes in WHOLE TICKS.
     *
     * Qualifying time is banked and every `SPEED.grantInterval` of it pays the
     * entire rate at once, so what the player sees is "+2" from a +2 mech
     * rather than the fraction that happened to have accumulated when the HUD
     * next looked. Time rather than distance, so the figure is identical on a
     * 30 Hz client and a 240 Hz one and does not fluctuate with acceleration.
     *
     * The loop rather than an `if`: a client that legitimately banks two
     * intervals in one step - a long frame, a burst after a stall - is paid
     * for both, and the remainder stays banked rather than being rounded away.
     * The epsilon is load-bearing: sixty steps of 1/60 sum to a hair under one
     * second in binary floating point, and without it a player walking at a
     * steady sixty frames a second would be paid every OTHER second.
     */
    let gained = 0;
    if (earning) {
      tracker.banked += step;
      while (tracker.banked + 1e-9 >= SPEED.grantInterval) {
        tracker.banked -= SPEED.grantInterval;
        gained += rate;
      }
    }

    tracker.x = player.x;
    tracker.z = player.z;
    tracker.fresh = false;

    const beforeLevel = player.level;
    if (gained > 0) player.totalSpeed += gained;

    this.syncDerived(player);

    return { gained, levelsGained: player.level - beforeLevel };
  }

  /**
   * Re-derive level and everything downstream from the current Speed total.
   *
   * Used on join, on reconnect and whenever the equipped robot changes: the
   * profile carries only the Speed earned, and level, movement speed and jump
   * velocity all follow from it through the same formulas a live step uses.
   */
  syncDerived(player: PlayerState): void {
    player.maxLevel = this.levelCap(player);
    player.level = resolveLevel(player.totalSpeed, player.maxLevel).level;

    const robot = robotForSlot(player.robotSlot);
    // The advertised rate is the one the payment uses, resolved the one way.
    player.speedPerStep = speedGainPerSecond(
      robot.speedPerSecond,
      player.rebirths,
      player.trailSlot,
      player.ownedTrails,
    );

    const profile = this.movementProfile(player);
    player.moveMultiplier = profile.multiplier;
    player.jumpVelocity = profile.jumpVelocity;
  }

  /**
   * THE player's movement profile.
   *
   * Level, the rebirth ladder, the equipped robot AND the equipped trail all
   * drive it, and every caller that needs a speed - the replicated multiplier,
   * the anti-teleport step cap - goes through here. What the player moves at
   * and what the server will credit therefore cannot disagree.
   *
   * The trail arrives as the shared formula's `extraMultiplier`, never as a
   * second calculation. `trailMultiplier` returns 1 for a slot the player does
   * not own, so a forged slot can only ever mean no bonus.
   */
  movementProfile(player: PlayerState): MovementProfile {
    const robot = robotForSlot(player.robotSlot);
    return resolveMovementProfile(
      player.level,
      player.rebirths,
      robot.moveBonus,
      robot.jumpBonus,
      trailMultiplier(player.trailSlot, player.ownedTrails),
    );
  }

  /** Speed still needed for the next level, for logging and diagnostics. */
  speedToNextLevel(player: PlayerState): number {
    return speedForNextLevel(player.level);
  }

  /**
   * Largest movement the server will credit from one simulated step.
   *
   * Derived from the player's OWN authoritative run speed and the step's own
   * duration rather than a fixed constant, so movement validation and movement
   * itself can never disagree.
   */
  private maxCreditedStep(player: PlayerState, stepSeconds: number): number {
    const step = Number.isFinite(stepSeconds)
      ? Math.max(0, Math.min(stepSeconds, MAX_SIM_DELTA))
      : MAX_SIM_DELTA;
    return this.movementProfile(player).moveSpeed * step * SPEED.creditSlack + 0.5;
  }

  private levelCap(player: PlayerState): number {
    return maxLevelForRebirth(player.rebirths);
  }
}
