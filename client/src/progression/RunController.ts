import {
  DISPLAYED_ROBOTS,
  STAND_ROW,
  robotForSlot,
  ownsRobot,
  returnPadAt,
  standDeckY,
  standX,
  standZ,
  winPadAt,
  type WorldCollision,
} from '@robot/shared';
import type { LocalPlayer } from '../player/LocalPlayer.js';

/** Seconds between two requests of the same kind. */
const REQUEST_COOLDOWN = 0.5;

/** What the controller may ask the server for. It never grants anything. */
export interface RunActions {
  claimStage(stageIndex: number): void;
  claimRobot(slot: number): void;
  /** "Put me back at the hangar." Carries nothing and decides nothing. */
  requestRespawn(): void;
}

/**
 * Turns the player's position into REQUESTS.
 *
 * The one job: notice that the mech has entered a trigger volume and ask the
 * server about it. Every actual decision - whether the stage pays, whether the
 * robot is affordable, whether the player is really standing there - is made
 * server-side against the transform the server itself simulated. Nothing here
 * awards anything, and nothing here can.
 *
 * The single exception to "ask, do not decide" is DEATH, and it is a
 * prediction rather than a decision: the client starts the fall-over animation
 * the moment it can see the mech is doomed, because waiting a round trip for
 * the server's confirmation means the machine keeps walking through thin air
 * for a tenth of a second. The server still decides; this only decides when to
 * start drawing.
 */
export class RunController {
  private readonly collision: WorldCollision;
  private readonly actions: RunActions;

  private stageCooldown = 0;
  private robotCooldown = 0;
  private returnCooldown = 0;

  /** Replicated ownership, so a plinth the player owns is not re-requested. */
  private ownedRobots = 0;
  private wins = 0;

  constructor(collision: WorldCollision, actions: RunActions) {
    this.collision = collision;
    this.actions = actions;
  }

  /** Mirror the replicated wallet and inventory. Display and gating only. */
  setInventory(ownedRobots: number, wins: number): void {
    this.ownedRobots = ownedRobots;
    this.wins = wins;
  }

  /**
   * @param elapsed the server's clock, for the hazard prediction. Hazards are
   *                a pure function of it on both sides.
   */
  update(delta: number, player: LocalPlayer, elapsed: number): void {
    this.stageCooldown = Math.max(0, this.stageCooldown - delta);
    this.robotCooldown = Math.max(0, this.robotCooldown - delta);
    this.returnCooldown = Math.max(0, this.returnCooldown - delta);

    // A mech already dying is not in any trigger volume that matters.
    if (player.isDying) return;

    const { x, y, z } = player.position;

    // Death prediction. The server confirms it with a Respawn; this is only
    // about starting the animation on the frame the player can see it happen.
    // `hasFallen` covers the death plane AND the lethal pools, so the two
    // cannot get different answers here and on the server.
    if (this.collision.hasFallen(x, y, z) || this.collision.touchesHazard(x, y, z, elapsed)) {
      player.beginDeath();
      return;
    }

    const stage = winPadAt(x, y, z);
    if (stage && this.stageCooldown === 0) {
      this.stageCooldown = REQUEST_COOLDOWN;
      this.actions.claimStage(stage.index);
    }

    /*
     * The RETURN pad, opposite the win pad at every stage end.
     *
     * It pays nothing and it is checked here rather than on the server because
     * there is no authority in it: `RequestRespawn` is a message the server
     * would honour from anywhere on the map, so a pad that sends one is a
     * convenience and not a permission. What it buys the player is a way home
     * from a stage they have already banked, which is otherwise only reachable
     * by dying.
     */
    if (this.returnCooldown === 0 && returnPadAt(x, y, z)) {
      this.returnCooldown = REQUEST_COOLDOWN;
      this.actions.requestRespawn();
    }

    const slot = this.standAt(x, y, z);
    if (slot !== null && this.robotCooldown === 0) {
      // Asking for a robot already owned, or one the player plainly cannot
      // afford, would be a request the server refuses every frame. The server
      // still checks both - this only keeps the wire quiet.
      const robot = robotForSlot(slot);
      if (!ownsRobot(this.ownedRobots, slot) && this.wins >= robot.winsRequired) {
        this.robotCooldown = REQUEST_COOLDOWN;
        this.actions.claimRobot(slot);
      }
    }
  }

  /**
   * Slot of the display plinth the player is on, or null.
   *
   * The same test the server runs, deliberately: a prediction that used
   * different bounds would ask for robots the server refuses. All three axes
   * matter because the deck has two storeys - the upper row sits behind the
   * lower one and nine units up, and a test that ignored Y would fire a
   * request for the mech above and behind the player every frame.
   */
  private standAt(x: number, y: number, z: number): number | null {
    for (let slot = 1; slot <= DISPLAYED_ROBOTS; slot += 1) {
      if (Math.abs(x - standX(slot)) > STAND_ROW.claimRadius) continue;
      if (Math.abs(z - standZ(slot)) > STAND_ROW.claimRadius) continue;
      const deck = standDeckY(slot);
      if (y < deck - 1 || y > deck + 4) continue;
      return slot;
    }
    return null;
  }
}
