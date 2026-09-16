import {
  DISPLAYED_ROBOTS,
  STAND_ROW,
  hasStand,
  robotBit,
  robotForSlot,
  bestOwnedRobot,
  ownsRobot,
  standDeckY,
  standX,
  standZ,
  type RobotDefinition,
} from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';
import type { SpeedService } from './SpeedService.js';
import { wallet } from './Wallet.js';

/** How a claim was resolved. */
export interface RobotClaim {
  readonly granted: boolean;
  readonly robot: RobotDefinition | null;
  readonly reason?: 'unknown-slot' | 'not-at-stand' | 'already-owned' | 'too-poor' | 'cooldown';
}

/**
 * Milliseconds between two accepted claims from one player.
 *
 * Spam protection ONLY, which is why it is short and why it is checked last.
 * An robot already owned or a player not at the stand is refused on its own
 * merits, and neither should ever be reported as a cooldown.
 */
const CLAIM_COOLDOWN_MS = 250;

/**
 * Server authority over which robots a player owns and which one they ride.
 *
 * Claiming is a DELIBERATE ACT and there are exactly TWO ways to perform it,
 * both of which arrive here as the same request:
 *
 *  - Walking the current mech onto a display plinth. Ten of the twelve robots
 *    have one, and that is what makes the hangar a place rather than a menu.
 *  - Pressing Buy in the mech panel on the HUD rail. Slots 11 and 12 have no
 *    plinth - the deck is two storeys of five, as specified - so the panel is
 *    the only route to them, and it is the same route for everything else.
 *
 * Reaching the Wins total alone still does nothing: a purchase is always
 * something the player did. Which route a request came by is NOT something the
 * server can see or needs to, because neither route decides anything - the
 * Wins check below is the whole authority, and it is the same check either
 * way.
 *
 * Wins are SPENT - the price is deducted here - and the best robot OWNED is
 * always equipped, so a purchase can never downgrade anyone and spending can
 * never remove an robot already claimed. Taking payment, granting the robot
 * and equipping it happen together in one method, so the wallet and the
 * inventory cannot disagree.
 */
export class RobotService {
  private readonly lastClaimAt = new Map<string, number>();

  initialise(player: PlayerState): void {
    this.lastClaimAt.set(player.sessionId, 0);
    this.equipBest(player);
  }

  forget(sessionId: string): void {
    this.lastClaimAt.delete(sessionId);
  }

  /**
   * Slot of the display plinth the player is standing on, or null.
   *
   * A pure position test against the authoritative transform, and the ONE
   * footprint test in the game - the server that charges and the client that
   * asks both call it, rather than each carrying its own loop.
   *
   * It has to check all three axes because the deck has two storeys: the upper
   * row sits directly behind the lower one and nine units higher, so a test
   * that ignored Y would let a player standing on the lower deck claim the
   * mech above and behind them.
   */
  standAt(x: number, y: number, z: number): number | null {
    for (let slot = 1; slot <= DISPLAYED_ROBOTS; slot += 1) {
      if (Math.abs(x - standX(slot)) > STAND_ROW.claimRadius) continue;
      if (Math.abs(z - standZ(slot)) > STAND_ROW.claimRadius) continue;
      const deck = standDeckY(slot);
      if (y < deck - 1 || y > deck + 4) continue;
      return slot;
    }
    return null;
  }

  /** Resolve a claim. The server decides; the client only asked. */
  claim(player: PlayerState, slot: number, speeds: SpeedService): RobotClaim {
    const requested = Math.floor(slot);
    const robot = robotForSlot(requested);
    if (robot.slot !== requested) {
      return { granted: false, robot: null, reason: 'unknown-slot' };
    }

    /*
     * The position check, against the transform the server itself simulated -
     * and it applies ONLY to robots that have a plinth.
     *
     * Slots past the display deck have nowhere to stand, so requiring a
     * position for them would make them unbuyable. `hasStand` is the one place
     * that distinction is written, and it is derived from the deck's own size
     * rather than from a hardcoded 10.
     */
    if (hasStand(robot.slot) && this.standAt(player.x, player.y, player.z) !== robot.slot) {
      return { granted: false, robot, reason: 'not-at-stand' };
    }

    if (ownsRobot(player.ownedRobots, robot.slot)) {
      return { granted: false, robot, reason: 'already-owned' };
    }

    if (!wallet.canAfford(player, robot.winsRequired)) {
      return { granted: false, robot, reason: 'too-poor' };
    }

    // Checked LAST, so the deterministic reasons above are always the ones
    // reported and a burst of requests cannot mask a real refusal.
    const now = Date.now();
    if (now - (this.lastClaimAt.get(player.sessionId) ?? 0) < CLAIM_COOLDOWN_MS) {
      return { granted: false, robot, reason: 'cooldown' };
    }

    // Payment, grant and equip together. Nothing between them can fail.
    if (!wallet.spend(player, robot.winsRequired)) {
      return { granted: false, robot, reason: 'too-poor' };
    }
    player.ownedRobots |= robotBit(robot.slot);
    this.lastClaimAt.set(player.sessionId, now);
    this.equipBest(player);
    // Movement speed, jump velocity and Speed-per-stride all follow from the
    // robot, so they are re-derived through the one formula rather than
    // written here.
    speeds.syncDerived(player);

    return { granted: true, robot };
  }

  /**
   * Equip the best robot owned.
   *
   * "Best" is by Speed per second, which is the order the display deck is in,
   * so this can never be a downgrade after a purchase.
   */
  equipBest(player: PlayerState): void {
    const best = bestOwnedRobot(player.ownedRobots);
    player.robotSlot = best.slot;
    player.speedPerStep = best.speedPerSecond;
  }
}
