import { Client, Room, ServerError } from '@colyseus/core';
import {
  RobotAnimationState,
  DEATH_HOLD_SECONDS,
  DEATH_PLACE_MARGIN,
  MAX_PLAYERS_PER_ROOM,
  MessageType,
  SPAWN_POSITION,
  SPAWN_ROTATION_Y,
  createMotion,
  type BuyTrailMessage,
  type ClaimRobotMessage,
  type ClaimStageMessage,
  type EquipTrailMessage,
  type MoveMessage,
  type PlayerMotion,
  type RespawnMessage,
  type RespawnReason,
  type StageAwardedMessage,
  sanitizeAppearance,
  sanitizeProportions,
  type SetAvatarMessage,
} from '@robot/shared';
import { serverConfig } from '../config/serverConfig.js';
import { MovementService } from '../movement/MovementService.js';
import { RobotService } from '../progression/RobotService.js';
import { buxGrants } from '../progression/BuxGrants.js';
import { leaderboardService } from '../progression/LeaderboardService.js';
import { profileStore } from '../progression/ProfileStore.js';
import { RebirthService } from '../progression/RebirthService.js';
import { SpeedService } from '../progression/SpeedService.js';
import { StageService } from '../progression/StageService.js';
import { wallet } from '../progression/Wallet.js';
import { TrailService } from '../progression/TrailService.js';
import { GuardianService } from '../world/GuardianService.js';
import { logger } from '../util/logger.js';
import { CourseState } from './state/CourseState.js';
import { PlayerState } from './state/PlayerState.js';

const SCOPE = 'CourseRoom';

/** Seconds between autosaves of every connected player. */
const AUTOSAVE_SECONDS = 15;

/** Options a client may pass on join. Both are cosmetic or identity only. */
interface JoinOptions {
  playerId?: string;
  name?: string;
  /** The Bloxity account id, when the player is signed in to the portal. */
  bloxityId?: string;
  /**
   * The player's Bloxity appearance, so they are drawn correctly by everyone
   * already in the room from their very first patch rather than after a
   * follow-up message has made the round trip.
   */
  avatar?: SetAvatarMessage;
}

/**
 * The authoritative room.
 *
 * Composition only: every rule lives in a service, and this decides the order
 * they run in. What it owns outright is the CLOCK - `state.elapsed` is what
 * the moving hazards are a pure function of, so a hazard death is decided
 * against the server's own time and never against a client's.
 *
 * The one hard rule: nothing a client sends is ever copied into state. A Move
 * is simulated, a claim is validated, and both produce a result the server
 * writes itself.
 */
export class CourseRoom extends Room<CourseState> {
  /**
   * Capacity, and the matchmaker's cue to open another room.
   *
   * Colyseus locks a room the moment this is reached and `joinOrCreate` sends
   * the next player to a fresh one, so a full server routes rather than
   * refuses. The figure is shared with the client so the two can never hold
   * different ideas of how big a room is.
   */
  override maxClients = MAX_PLAYERS_PER_ROOM;

  /**
   * AN EMPTY ROOM CLOSES ITSELF.
   *
   * Colyseus already defaults this to true, and it is written out anyway
   * because it is a requirement of this game rather than an accident of the
   * framework's defaults: the moment the last client leaves, the room is
   * disposed, its simulation interval is cleared and its state is freed. A
   * long-lived server that kept an empty room per stage anybody had ever
   * played would leak a tick loop apiece.
   *
   * `onDispose` is what makes that safe: every remaining player's progression
   * is written out before the room dies, so a player disconnecting alone loses
   * nothing.
   */
  override autoDispose = true;

  private readonly movement = new MovementService();
  private readonly speeds = new SpeedService();
  private readonly stages = new StageService();
  private readonly robots = new RobotService();
  private readonly rebirths = new RebirthService();
  private readonly trails = new TrailService();
  private readonly guardian = new GuardianService();

  /** Browser-stored player id per session, for persistence. */
  private readonly playerIds = new Map<string, string>();

  /**
   * Bloxity account id per session, for Bux fulfilment.
   *
   * Separate from `playerIds` because they are different identities: the
   * player id is a uuid this browser generated and the Bloxity id belongs to
   * an account that can sign in from anywhere. A purchase is made by the
   * ACCOUNT, so that is what a grant is addressed to.
   */
  private readonly bloxityIds = new Map<string, string>();

  /** Scratch motion, so the per-tick death check allocates nothing. */
  private readonly scratch: PlayerMotion = createMotion();

  /**
   * Players who are DEAD BUT NOT YET PLACED, and how long is left of it.
   *
   * A death is two halves: the mech is frozen where it fell while its
   * fall-over plays, and only then is it put back at the spawn. This is the
   * first half - see `DEATH_HOLD_SECONDS`, and `beginDeath` for what being in
   * here means: no input simulated, no Speed credited, and no second death
   * triggered by the pit the body is already lying in.
   */
  private readonly dying = new Map<string, { remaining: number; reason: RespawnReason }>();

  private autosaveTimer = 0;

  override onCreate(): void {
    this.state = new CourseState();
    this.setPatchRate(serverConfig.patchRateMs);

    this.onMessage(MessageType.Move, (client, message: MoveMessage) =>
      this.onMove(client, message),
    );
    this.onMessage(MessageType.ClaimStage, (client, message: ClaimStageMessage) =>
      this.onClaimStage(client, message),
    );
    this.onMessage(MessageType.ClaimRobot, (client, message: ClaimRobotMessage) =>
      this.onClaimRobot(client, message),
    );
    this.onMessage(MessageType.RequestRespawn, (client) =>
      this.respawn(client, 'manual'),
    );
    this.onMessage(MessageType.Rebirth, (client) => this.onRebirth(client));
    this.onMessage(MessageType.BuyTrail, (client, message: BuyTrailMessage) =>
      this.onBuyTrail(client, message),
    );
    this.onMessage(MessageType.SetAvatar, (client, message: SetAvatarMessage) =>
      this.onSetAvatar(client, message),
    );
    this.onMessage(MessageType.EquipTrail, (client, message: EquipTrailMessage) =>
      this.onEquipTrail(client, message),
    );

    this.guardian.reset(this.state.guardian);

    this.setSimulationInterval(
      (deltaMs) => this.tick(deltaMs / 1000),
      serverConfig.patchRateMs,
    );

    logger.info(
      SCOPE,
      `room ${this.roomId} created (capacity ${MAX_PLAYERS_PER_ROOM})`,
    );
  }

  /**
   * The capacity check that does not depend on the matchmaker.
   *
   * `maxClients` is enforced when a seat is RESERVED, which is the right place
   * and covers every normal join. This is the second line: a seat reservation
   * that is consumed late, a direct `joinById` into a room that filled while
   * the request was in flight, or any future path that reaches a room without
   * going through matchmaking would all arrive here. Refusing at the door
   * costs one comparison and makes the limit a property of the ROOM rather
   * than of the route taken to it.
   *
   * Nothing about this is client-side: a client cannot decline to call it and
   * cannot see the number it is compared against.
   */
  override onAuth(): boolean {
    if (this.clients.length >= MAX_PLAYERS_PER_ROOM) {
      logger.warn(
        SCOPE,
        `refused a join: room ${this.roomId} is full ` +
          `(${this.clients.length}/${MAX_PLAYERS_PER_ROOM})`,
      );
      throw new ServerError(4103, 'room is full');
    }
    return true;
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const player = new PlayerState();
    player.sessionId = client.sessionId;

    const playerId = typeof options.playerId === 'string' ? options.playerId.slice(0, 64) : '';
    if (playerId) this.playerIds.set(client.sessionId, playerId);

    // Restore BEFORE any service initialises: level, movement speed and the
    // equipped robot are all derived from the restored figures, so restoring
    // afterwards would leave every one of them a step out of date.
    const restored = playerId ? profileStore.restore(playerId, player) : false;

    this.state.players.set(client.sessionId, player);

    this.movement.initialise(player);
    this.robots.initialise(player);
    this.trails.initialise(player);
    this.speeds.initialise(player);
    this.stages.initialise(client.sessionId);

    const bloxityId = typeof options.bloxityId === 'string' ? options.bloxityId : '';
    if (bloxityId) {
      this.bloxityIds.set(client.sessionId, bloxityId);
      // Anything bought while they were away, or in another session.
      this.applyGrants(client.sessionId, player);
    }
    if (options.avatar) this.writeAvatar(player, options.avatar);

    this.rebirths.sync(player);

    // `initialise` reset the level to 1 for a fresh profile; a restored one
    // has to be re-derived from the Speed it came back with.
    if (restored) this.speeds.syncDerived(player);

    // Put the player at spawn through the SAME path a respawn takes, so there
    // is one definition of "where a player belongs" rather than two.
    this.placeAt(client, player, 'join');

    logger.info(
      SCOPE,
      `join ${client.sessionId} (${restored ? 'restored' : 'new'}) ` +
        `level=${player.level} wins=${player.wins} robot=${player.robotSlot}`,
    );
  }

  override onLeave(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    const playerId = this.playerIds.get(client.sessionId);
    if (player && playerId) profileStore.save(playerId, player);

    this.state.players.delete(client.sessionId);
    this.movement.forget(client.sessionId);
    this.speeds.forget(client.sessionId);
    this.stages.forget(client.sessionId);
    this.bloxityIds.delete(client.sessionId);
    this.robots.forget(client.sessionId);
    this.trails.forget(client.sessionId);
    this.playerIds.delete(client.sessionId);
    // A player who disconnects mid-death has no placement coming: without this
    // their hold would tick down for ever against a session that is gone.
    this.dying.delete(client.sessionId);

    logger.info(SCOPE, `leave ${client.sessionId}`);
  }

  override onDispose(): void {
    // Every remaining player's progression, made durable before the room dies.
    for (const [sessionId, player] of this.state.players) {
      const playerId = this.playerIds.get(sessionId);
      if (playerId) profileStore.save(playerId, player);
    }
    logger.info(SCOPE, `room ${this.roomId} disposed`);
  }

  /**
   * One input: simulate it, then pay for the movement it actually produced.
   *
   * The ORDER is the whole point. `applyInput` writes the authoritative
   * transform, and only then does `credit` measure the distance between the
   * previous authoritative position and this one. Crediting from the message
   * would be paying a client for a number it chose.
   *
   * Both halves of the question come from the server's own step: the FORWARD
   * intent is the sanitised input the simulation steered with, and the
   * DISTANCE is between two positions the server computed. A player who is
   * not moving forward is not paid, whatever their client says.
   */
  private onMove(client: Client, message: MoveMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    /*
     * A DEAD MECH DOES NOT MOVE, and it does not earn.
     *
     * While the fall-over is playing the machine is frozen where it died, so
     * its input is dropped rather than simulated: gravity would otherwise walk
     * the corpse on down through the pit it fell into and re-trigger the death
     * it is already having, and `credit` would pay for the drop.
     *
     * The client is frozen too and sends neutral input through this window; it
     * keeps sending SOMETHING on purpose, so the flow of inputs never stops and
     * the server can tell a dying player from one whose connection died.
     */
    if (this.dying.has(client.sessionId)) return;

    if (
      !this.movement.applyInput(client.sessionId, player, message, this.state.elapsed)
    ) {
      return;
    }

    this.speeds.credit(
      client.sessionId,
      player,
      this.movement.lastStep,
      this.movement.lastDroveForward,
    );
    player.animation = resolveAnimation(player);
  }

  /** A stage claim. The server validates it against its own transform. */
  private onClaimStage(client: Client, message: ClaimStageMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const index = Number(message?.stageIndex);
    if (!Number.isFinite(index)) return;

    const award = this.stages.claim(client.sessionId, player, index);
    if (!award.granted || !award.stage) return;

    const payload: StageAwardedMessage = {
      stageIndex: award.stage.index,
      wins: award.wins,
      total: player.wins,
    };
    client.send(MessageType.StageAwarded, payload);

    // Banking a stage RETURNS the player to the starting arena. That is the
    // loop the win pad's "Return" label promises, and it is also what makes a
    // second payment impossible: the pad is hundreds of units behind them
    // before another request could arrive.
    this.placeAt(client, player, 'stage');

    this.persist(client.sessionId, player);
    logger.info(
      SCOPE,
      `stage ${award.stage.index} banked by ${client.sessionId} (+${award.wins} wins, total ${player.wins})`,
    );
  }

  /** An robot claim. The server takes the payment and grants the robot. */
  private onClaimRobot(client: Client, message: ClaimRobotMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const slot = Number(message?.slot);
    if (!Number.isFinite(slot)) return;

    const claim = this.robots.claim(player, slot, this.speeds);
    if (!claim.granted || !claim.robot) return;

    this.persist(client.sessionId, player);
    logger.info(
      SCOPE,
      `${client.sessionId} claimed ${claim.robot.name} (wins left ${player.wins})`,
    );
  }

  /** A rebirth request. The server alone decides whether it is allowed. */
  private onRebirth(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const result = this.rebirths.rebirth(player, this.speeds);
    if (!result.ok) return;

    // A rebirth resets the RUN as well as the curve: the player's level - and
    // therefore their speed - is no longer what carried them to wherever they
    // were standing, so they start again from the arena.
    this.placeAt(client, player, 'rebirth');
    this.persist(client.sessionId, player);
    logger.info(
      SCOPE,
      `${client.sessionId} rebirthed to ${result.rebirths} (x${result.multiplier})`,
    );
  }

  /** A trail purchase. The server takes the payment and grants the trail. */
  private onBuyTrail(client: Client, message: BuyTrailMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const result = this.trails.buy(player, message?.slot, this.speeds);
    if (!result.ok) return;

    this.persist(client.sessionId, player);
    logger.info(
      SCOPE,
      `${client.sessionId} bought ${result.tier.name} (wins left ${result.winsAfter})`,
    );
  }

  /** Equip an owned trail, or 0 to take it off. */
  private onEquipTrail(client: Client, message: EquipTrailMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (!this.trails.equip(player, message?.slot, this.speeds).ok) return;
    this.persist(client.sessionId, player);
  }

  /**
   * "This is what I look like."
   *
   * Accepted rather than adjudicated, which is the opposite of every other
   * client message here and is safe for one reason: the payload decides
   * nothing. The portal owns a player's appearance and this server has no way
   * to ask it, so the client is the only source of the truth - and the worst a
   * forged one achieves is wearing a hat it did not buy, on its own screen and
   * everyone else's. It is NOT persisted: the appearance lives in the player's
   * Bloxity account, and a copy in the profile would be a second one to keep
   * in step with the first.
   */
  private onSetAvatar(client: Client, message: SetAvatarMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this.writeAvatar(player, message);
  }

  /** Sanitise, then write in place. The one path an appearance is set by. */
  private writeAvatar(player: PlayerState, message: SetAvatarMessage): void {
    player.avatar.apply(
      sanitizeAppearance(message?.appearance),
      sanitizeProportions(message?.proportions),
    );
  }

  /**
   * The per-tick pass the client cannot influence.
   *
   * Deaths are decided HERE, from the position the server simulated and the
   * clock the server owns, rather than from a client saying it was hit. There
   * is no hazard message in this game for exactly that reason.
   */
  /**
   * Begin a death: freeze the mech where it fell and start the hold.
   *
   * The PLACEMENT is deliberately not here. It happens `DEATH_HOLD_SECONDS`
   * later, in the tick, once the fall-over everyone can see has played out at
   * the place it belongs to - see `DEATH_HOLD_SECONDS` for why that matters.
   *
   * The death COUNT is bumped here rather than at the placement, because this
   * is the moment the player died: every other client derives its fall-over
   * from a change in that number, so counting it at the placement would have
   * them all topple at the spawn point half a second late.
   */
  private beginDeath(sessionId: string, player: PlayerState, reason: RespawnReason): void {
    if (this.dying.has(sessionId)) return;
    // The animation's own length PLUS the margin, so the fall-over has always
    // finished before the placement lands - see `DEATH_PLACE_MARGIN`.
    this.dying.set(sessionId, {
      remaining: DEATH_HOLD_SECONDS + DEATH_PLACE_MARGIN,
      reason,
    });
    player.deathCount += 1;
    player.animation = RobotAnimationState.Dying;
    logger.info(SCOPE, `death ${sessionId} (${reason}) at ${player.z.toFixed(0)}`);
  }

  /**
   * Count down every held death and place the ones that have finished.
   *
   * Collected before placing rather than placed inside the walk, because
   * `placeAt` writes to the very state this is iterating.
   */
  private tickDeaths(delta: number): void {
    if (this.dying.size === 0) return;

    const done: string[] = [];
    for (const [sessionId, held] of this.dying) {
      held.remaining -= delta;
      if (held.remaining <= 0) done.push(sessionId);
    }

    for (const sessionId of done) {
      const held = this.dying.get(sessionId);
      this.dying.delete(sessionId);
      const player = this.state.players.get(sessionId);
      const client = this.clients.find((c) => c.sessionId === sessionId);
      if (!held || !player || !client) continue;
      this.placeAt(client, player, held.reason);
    }
  }

  private tick(delta: number): void {
    this.state.elapsed += delta;
    const time = this.state.elapsed;

    // The guardian CHASES, so it cannot be a pure function of time. The server
    // moves it from the authoritative positions it already has, and the kill
    // below is decided against that same position.
    this.guardian.update(this.state.guardian, delta, this.state.players.values());

    // The boards on the spawn wall. Rebuilt on their own slow timer inside the
    // service - a leaderboard is not a thing anyone reads twenty times a
    // second, and sorting every profile at tick rate to feed a sign would be
    // the most expensive thing in this room.
    leaderboardService.update(delta, this.state.leaderboard, this.state.players, this.playerIds);

    /*
     * Bux bought by someone already in the room.
     *
     * Guarded on `hasPending` so the common case - nobody has bought anything
     * - is one boolean per tick rather than a walk of every player. The
     * webhook queues rather than writing, because a direct write to the stored
     * profile would be overwritten by this player's next autosave.
     */
    if (buxGrants.hasPending) {
      for (const [sessionId, player] of this.state.players) {
        this.applyGrants(sessionId, player);
      }
    }

    for (const [sessionId, player] of this.state.players) {
      if (!player.ready) continue;
      // Already dying: the mech is frozen where it fell and its placement is
      // counting down. Testing it again would restart the hold for ever.
      if (this.dying.has(sessionId)) continue;

      const triggers = this.movement.collision.sampleTriggers(
        player.x,
        player.y,
        player.z,
        time,
      );
      const rundown = this.guardian.hits(this.state.guardian, player);

      if (triggers.fell || triggers.hazard || rundown) {
        this.beginDeath(sessionId, player, triggers.fell ? 'fell' : 'hazard');
      }
    }

    // Deaths that have finished their fall-over are placed now.
    this.tickDeaths(delta);

    this.autosaveTimer += delta;
    if (this.autosaveTimer >= AUTOSAVE_SECONDS) {
      this.autosaveTimer = 0;
      // Speed accrues continuously between the discrete events that otherwise
      // trigger a save, so a crash without this would cost a whole session.
      for (const [sessionId, player] of this.state.players) {
        this.persist(sessionId, player);
      }
    }
  }

  /**
   * Hand over anything this player has paid for and not yet received.
   *
   * Wins go through `wallet.add` like every other award in the game - there is
   * exactly one place they move, and a payment is not an excuse to open a
   * second one. The profile is saved immediately so a crash between the
   * webhook and the next autosave cannot lose a purchase.
   */
  private applyGrants(sessionId: string, player: PlayerState): void {
    const bloxityId = this.bloxityIds.get(sessionId);
    if (!bloxityId) return;

    const grants = buxGrants.drain(bloxityId);
    if (grants.length === 0) return;

    for (const grant of grants) {
      if (grant.wins > 0) wallet.add(player, grant.wins);
      logger.info(
        SCOPE,
        `granted ${grant.sku} to ${sessionId} (+${grant.wins} wins) [${grant.transactionId}]`,
      );
    }
    this.persist(sessionId, player);
  }

  /** Put a player back at the starting arena and tell them so. */
  private respawn(client: Client, reason: RespawnReason): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this.placeAt(client, player, reason);
  }

  /**
   * THE one way a player is placed, and there is exactly ONE destination.
   *
   * `SPAWN_POSITION` - the starting arena - whatever the cause and whatever
   * stage the player was on. There are no checkpoints in this game and no
   * second place a player can arrive at, which is why this takes no position:
   * a placement that could land somewhere else is the bug the parameter used
   * to allow.
   *
   * Teleports the simulation, drops the Speed baseline (or the teleport itself
   * would be credited as distance travelled), and sends the authoritative
   * transform.
   */
  private placeAt(client: Client, player: PlayerState, reason: RespawnReason): void {
    this.movement.teleport(
      client.sessionId,
      player,
      SPAWN_POSITION.x,
      SPAWN_POSITION.y,
      SPAWN_POSITION.z,
      SPAWN_ROTATION_Y,
    );
    this.speeds.reset(client.sessionId, player);
    player.animation = RobotAnimationState.Idle;
    /*
     * A placement CLEARS a death; it never starts one.
     *
     * The counter is bumped in `beginDeath`, at the moment the player actually
     * died, because every other client derives its fall-over from a change in
     * that number and they all have to topple at the place it happened. This
     * also drops any hold still counting down, so a manual respawn during a
     * death cannot be followed by a second placement a moment later.
     */
    this.dying.delete(client.sessionId);

    const message: RespawnMessage = {
      x: SPAWN_POSITION.x,
      y: SPAWN_POSITION.y,
      z: SPAWN_POSITION.z,
      rotationY: SPAWN_ROTATION_Y,
      reason,
    };
    client.send(MessageType.Respawn, message);

    // Every placement is logged with its cause. A player who finds themselves
    // back at the arena and cannot say why is the hardest bug in this game to
    // diagnose from the outside, and one line here answers it.
    if (reason !== 'join') {
      logger.info(SCOPE, `place ${client.sessionId} -> spawn (${reason})`);
    }
  }

  private persist(sessionId: string, player: PlayerState): void {
    const playerId = this.playerIds.get(sessionId);
    if (playerId) profileStore.save(playerId, player);
  }
}

/**
 * The animation state a replicated player is in.
 *
 * Derived from motion the server already owns rather than reported by the
 * client, so a remote character can never be made to play an animation its
 * actual movement does not justify. Presentation, but presentation the server
 * is the source of.
 */
const resolveAnimation = (player: PlayerState): RobotAnimationState => {
  /*
   * AIRBORNE WINS, and it wins first - split by which WAY the mech is going.
   *
   * A frame on the way up and a frame on the way down are the same object in
   * two completely different attitudes, and the sign of the replicated
   * vertical velocity is the only thing that tells them apart. Deciding this
   * after the speed test is what would leave a mech leaving the ground drawn
   * mid-stride, which is exactly the moment the player is looking for
   * confirmation that the key did something.
   */
  if (!player.grounded) {
    return player.verticalVelocity > 0
      ? RobotAnimationState.Jumping
      : RobotAnimationState.Falling;
  }
  // A player on a belt is travelling nowhere and is very much running, so the
  // replicated state has to say so - reporting `idle` would be the one field
  // on the wire that disagrees with what everybody can see.
  if (player.treadmill > 0) return RobotAnimationState.Run;
  const idleThreshold = 0.6;
  if (player.speed < idleThreshold) return RobotAnimationState.Idle;
  // The run threshold scales with the player's own authoritative speed, so a
  // level-160 mech is not permanently "walking" at eighty units a second.
  return player.speed > player.moveMultiplier * 16
    ? RobotAnimationState.Run
    : RobotAnimationState.Walk;
};
