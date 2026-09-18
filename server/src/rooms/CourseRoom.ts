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
  sanitizeIdentity,
  sanitizeProportions,
  type SetAvatarMessage,
  type SetAuthTokenMessage,
  type SetIdentityMessage,
} from '@robot/shared';
import { serverConfig } from '../config/serverConfig.js';
import { MovementService } from '../movement/MovementService.js';
import { RobotService } from '../progression/RobotService.js';
import { buxGrants } from '../progression/BuxGrants.js';
import { leaderboardService } from '../progression/LeaderboardService.js';
import { bloxityAuth } from '../auth/BloxityAuth.js';
import { withTimeout } from '../persistence/JsonStore.js';
import { profileStore, type Identity, type Resolved } from '../progression/ProfileStore.js';
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

/** Seconds between checks of the shared store for a signed-in player's purchases. */
const GRANT_POLL_SECONDS = 10;

/**
 * How long a login switch waits for the profile it is LEAVING to be durable.
 *
 * Bounded, because the write queue itself never gives up: during an outage it
 * would wait for ever, and a switch has to be able to say "storage is down,
 * stay where you are". The write is not abandoned - it lands when it can.
 */
const SWITCH_SAVE_MS = 6000;

/** Backoff between re-verifies of a token Bloxity could not check. Last repeats. */
const REVERIFY_SECONDS = [5, 15, 45, 120, 300] as const;

/** Options a client may pass on join. Both are cosmetic or identity only. */
interface JoinOptions {
  /** The browser-stored guest id. Refused if it is in the account key space. */
  playerId?: string;
  name?: string;
  /**
   * The portal's TOKEN, when the player is signed in. Verified with Bloxity in
   * `onAuth`; the account id comes from Bloxity's answer and nowhere else.
   * There is deliberately no account-id option: a browser that could name an
   * account could name anybody's.
   */
  token?: string;
  /**
   * The player's Bloxity appearance, so they are drawn correctly by everyone
   * already in the room from their very first patch rather than after a
   * follow-up message has made the round trip.
   */
  avatar?: SetAvatarMessage;
  /**
   * The player's portal display name and portrait, for the same reason the
   * avatar is here: everybody already in the room should draw this player by
   * NAME from their first patch rather than as a generated handle until a
   * follow-up message has made the round trip.
   */
  identity?: SetIdentityMessage;
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

  /**
   * Storage key per session: `bloxity:<account>` for a verified login, the
   * browser id for a guest, absent for an ephemeral session. The leaderboard
   * reads this to line live players up with their stored profiles.
   */
  private readonly playerIds = new Map<string, string>();

  /**
   * WHO each session is. Only ever set from a token Bloxity verified, or from
   * a sanitised browser id - never from an account id a client supplied.
   */
  private readonly identities = new Map<string, Identity>();

  /** The last token each session presented, for re-verifying an outage. */
  private readonly tokens = new Map<string, string>();

  /**
   * Sessions mid login-switch. Their autosaves are BLOCKED while the profile
   * underneath them is being swapped - a save landing half-way through would
   * write one profile's state into the other's key.
   */
  private readonly switching = new Set<string>();

  /** The newest login that arrived mid-switch. Only the newest counts. */
  private readonly queuedTokens = new Map<string, string>();

  /** Re-verify timers for sessions whose Bloxity check was `unavailable`. */
  private readonly reverify = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >();

  /** Sessions with a grant claim in flight, so two never overlap. */
  private readonly claiming = new Set<string>();

  /** Seconds since signed-in sessions were last checked for purchases. */
  private grantTimer = 0;

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
    this.onMessage(MessageType.SetAuthToken, (client, message: SetAuthTokenMessage) =>
      this.onAuthToken(client, message),
    );
    this.onMessage(MessageType.SetIdentity, (client, message: SetIdentityMessage) =>
      this.onSetIdentity(client, message),
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
  override async onAuth(_client: Client, options: JoinOptions = {}): Promise<Resolved> {
    if (this.clients.length >= MAX_PLAYERS_PER_ROOM) {
      logger.warn(
        SCOPE,
        `refused a join: room ${this.roomId} is full ` +
          `(${this.clients.length}/${MAX_PLAYERS_PER_ROOM})`,
      );
      throw new ServerError(4103, 'room is full');
    }

    /*
     * WHO THIS IS, AND THEIR PROFILE, READ FROM STORAGE NOW.
     *
     * The token is verified with Bloxity; the profile is read at this moment,
     * not from anything cached at boot, because another pod may have saved
     * this player a second ago.
     *
     * If storage cannot be READ the join is REFUSED - not let in empty. A
     * player admitted on an empty profile would autosave over their real one
     * within fifteen seconds. The client's join backoff retries, and gets in
     * as soon as the database is back.
     */
    try {
      return await profileStore.resolveJoin(options.token, options.playerId);
    } catch (error) {
      logger.error(
        SCOPE,
        `refused a join: storage unreadable - ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServerError(4105, 'progress storage is unavailable, retrying');
    }
  }

  override onJoin(client: Client, options: JoinOptions = {}, auth?: Resolved): void {
    const player = new PlayerState();
    player.sessionId = client.sessionId;

    const identity: Identity = auth?.identity ?? {
      kind: 'ephemeral',
      key: '',
      accountId: '',
      browserId: '',
      verification: 'none',
    };
    this.identities.set(client.sessionId, identity);
    if (identity.key) this.playerIds.set(client.sessionId, identity.key);
    if (typeof options.token === 'string' && options.token) {
      this.tokens.set(client.sessionId, options.token);
    }

    // Restore BEFORE any service initialises: level, movement speed and the
    // equipped robot are all derived from the restored figures, so restoring
    // afterwards would leave every one of them a step out of date.
    const restored = profileStore.restore(auth?.profile ?? null, player);

    this.state.players.set(client.sessionId, player);

    this.movement.initialise(player);
    this.robots.initialise(player);
    this.trails.initialise(player);
    this.speeds.initialise(player);
    this.stages.initialise(client.sessionId);

    // Anything bought while they were away, or on another pod. Only ever for a
    // VERIFIED account - never for an id a client merely claimed.
    if (identity.kind === 'account') void this.applyGrants(client.sessionId);
    // Bloxity could not be asked: play as a guest now, become the account the
    // moment it answers.
    if (identity.verification === 'unavailable') this.scheduleReverify(client);

    if (options.avatar) this.writeAvatar(player, options.avatar);
    /*
     * The name they are seen under.
     *
     * A restored profile may already carry one; a signed-in player's own claim
     * is newer, so it wins. A signed-OUT player sends nothing and keeps
     * whatever the profile had, which is what stops a name flickering back to
     * a generated handle on a reconnect.
     */
    if (options.identity) {
      const identity = sanitizeIdentity(options.identity);
      if (identity.displayName) {
        player.displayName = identity.displayName;
        player.avatarUrl = identity.avatarUrl;
      }
    }

    this.rebirths.sync(player);

    // `initialise` reset the level to 1 for a fresh profile; a restored one
    // has to be re-derived from the Speed it came back with.
    if (restored) this.speeds.syncDerived(player);

    // Put the player at spawn through the SAME path a respawn takes, so there
    // is one definition of "where a player belongs" rather than two.
    this.placeAt(client, player, 'join');

    logger.info(
      SCOPE,
      `join ${client.sessionId} as ${describeIdentity(identity)} ` +
        `(${auth?.migrated ? 'migrated' : restored ? 'restored' : 'new'}) ` +
        `level=${player.level} wins=${player.wins} robot=${player.robotSlot}`,
    );
  }

  override onLeave(client: Client): void {
    const sessionId = client.sessionId;
    const player = this.state.players.get(sessionId);
    const identity = this.identities.get(sessionId);
    // Saved even mid-switch: the key is still the one this session was on,
    // and the switch notices the player has gone and stops.
    if (player && identity?.key) void profileStore.save(identity.key, player);

    this.state.players.delete(sessionId);
    this.movement.forget(sessionId);
    this.speeds.forget(sessionId);
    this.stages.forget(sessionId);
    this.robots.forget(sessionId);
    this.trails.forget(sessionId);
    this.playerIds.delete(sessionId);
    this.identities.delete(sessionId);
    this.tokens.delete(sessionId);
    this.queuedTokens.delete(sessionId);
    this.cancelReverify(sessionId);
    if (identity?.key && !this.keyInUse(identity.key)) profileStore.forget(identity.key);
    // A player who disconnects mid-death has no placement coming: without this
    // their hold would tick down for ever against a session that is gone.
    this.dying.delete(client.sessionId);

    logger.info(SCOPE, `leave ${client.sessionId}`);
  }

  override onDispose(): void {
    // Every remaining player's progression, made durable before the room dies.
    for (const [sessionId, player] of this.state.players) {
      const key = this.identities.get(sessionId)?.key;
      if (key) void profileStore.save(key, player);
    }
    for (const sessionId of [...this.reverify.keys()]) this.cancelReverify(sessionId);
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

  /**
   * The player's VISIBLE identity: their portal display name and portrait.
   *
   * Sent on join and again whenever the portal reports a different user, so a
   * player who signs in mid-session is renamed for everyone without a reload.
   * Sanitised before it is written - a name is drawn and never trusted, and a
   * portrait that is not on the portal's CDN is dropped.
   *
   * The board is rebuilt immediately rather than on its slow timer: a player
   * watching their own name appear two seconds late would reasonably assume it
   * had not worked.
   */
  private onSetIdentity(client: Client, message: SetIdentityMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const identity = sanitizeIdentity(message);
    if (player.displayName === identity.displayName && player.avatarUrl === identity.avatarUrl) {
      return;
    }
    player.displayName = identity.displayName;
    player.avatarUrl = identity.avatarUrl;
    // Names live on the profile too, so the boards can still name this player
    // once they have left the room.
    this.persist(client.sessionId, player);
    leaderboardService.rebuild(this.state.leaderboard, this.state.players, this.playerIds);
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
     * POLLED from the shared store on a slow timer, because the webhook is
     * load-balanced across pods and may well have landed on another one: no
     * in-memory flag in THIS pod could know. Only verified accounts are
     * checked, and each check is one indexed query that almost always finds
     * nothing.
     */
    this.grantTimer += delta;
    if (this.grantTimer >= GRANT_POLL_SECONDS) {
      this.grantTimer = 0;
      for (const [sessionId, identity] of this.identities) {
        if (identity.kind === 'account') void this.applyGrants(sessionId);
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
  private async applyGrants(sessionId: string): Promise<void> {
    const identity = this.identities.get(sessionId);
    if (identity?.kind !== 'account' || !identity.accountId) return;
    if (this.claiming.has(sessionId) || this.switching.has(sessionId)) return;
    this.claiming.add(sessionId);
    try {
      const grants = await buxGrants.claim(identity.accountId, `${this.roomId}/${sessionId}`);
      if (grants.length === 0) return;

      // Still the same session on the same account? If it switched or left
      // while the claim was in flight, the lease simply runs out and the
      // grants are claimed again by whoever that account is next.
      const player = this.state.players.get(sessionId);
      if (!player || this.identities.get(sessionId) !== identity) return;

      for (const grant of grants) {
        // Already credited INTO this profile - a claim that re-took a grant
        // whose previous claimer saved and then died before settling it.
        if (profileStore.hasApplied(identity.key, grant.transactionId)) continue;
        if (grant.wins > 0) wallet.add(player, grant.wins);
        profileStore.noteApplied(identity.key, grant.transactionId);
        logger.info(
          SCOPE,
          `granted ${grant.sku} to ${identity.key} (+${grant.wins} wins) [${grant.transactionId}]`,
        );
      }
      // Durable FIRST - the Wins and the transaction ids in one document -
      // and only then settled. A crash in between re-claims, never loses.
      await profileStore.save(identity.key, player);
      await buxGrants.settle(grants.map((grant) => grant.transactionId));
    } catch (error) {
      logger.warn(
        SCOPE,
        `grant check for ${identity.key} failed, will retry: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.claiming.delete(sessionId);
    }
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

  // ------------------------------------------------------------- login switch

  /**
   * The portal login changed on a live session: signed in, signed out, or a
   * different account.
   *
   * Handled HERE, on the session, rather than by reconnecting. A reconnect can
   * land on a different pod before this one's last write has reached the
   * database, and would then load the profile it had just left from an older
   * copy.
   *
   * Serialised per session, and only the NEWEST login counts: one that
   * arrives mid-switch is queued, replacing any older one still queued, and
   * run when the current switch finishes.
   */
  private onAuthToken(client: Client, message: SetAuthTokenMessage): void {
    const sessionId = client.sessionId;
    if (!this.identities.has(sessionId)) return;
    const token = typeof message?.token === 'string' ? message.token.slice(0, 8192) : '';
    if (this.switching.has(sessionId)) {
      this.queuedTokens.set(sessionId, token);
      return;
    }
    void this.switchLogin(client, token);
  }

  private async switchLogin(client: Client, first: string): Promise<void> {
    const sessionId = client.sessionId;
    this.switching.add(sessionId);
    try {
      let token: string | undefined = first;
      while (token !== undefined) {
        await this.applyLogin(client, token);
        token = this.queuedTokens.get(sessionId);
        this.queuedTokens.delete(sessionId);
      }
    } finally {
      this.switching.delete(sessionId);
    }
  }

  /**
   * Move one session from the profile it is on to the one this login means.
   *
   * The order is the whole point:
   *
   *  1. Work out the target. Nothing is touched yet.
   *  2. Save the profile being LEFT, from live state, and wait for it to be
   *     durable. If storage cannot take it, STOP - the session stays exactly
   *     where it was, and the queued write lands later.
   *  3. Read the target profile - seeding an empty account from this session's
   *     LIVE guest progress on a first login. A failed read also stops here.
   *  4. Apply it, re-running the same service initialisation order as
   *     `onJoin`, re-apply any purchases, and put the player at the spawn.
   */
  private async applyLogin(client: Client, token: string): Promise<void> {
    const sessionId = client.sessionId;
    const current = this.identities.get(sessionId);
    const player = this.state.players.get(sessionId);
    if (!current || !player) return;

    if (token) this.tokens.set(sessionId, token);
    else this.tokens.delete(sessionId);

    const verification = token ? await bloxityAuth.verify(token) : null;
    if (!this.state.players.has(sessionId)) return;

    let accountId = '';
    if (verification?.status === 'verified') {
      this.cancelReverify(sessionId);
      if (current.kind === 'account' && current.accountId === verification.accountId) return;
      accountId = verification.accountId;
    } else if (verification?.status === 'unavailable') {
      // Cannot tell who this is right now. Stay put - demoting a signed-in
      // player to a guest because Bloxity blinked would be wrong - and ask
      // again shortly.
      this.scheduleReverify(client);
      return;
    } else {
      // Signed out, or a token Bloxity rejected: fail closed, to a guest.
      this.cancelReverify(sessionId);
      if (current.kind !== 'account') return;
    }

    try {
      // 2. The profile being LEFT, durable before anything else changes.
      if (current.key) {
        await withTimeout(profileStore.save(current.key, player), SWITCH_SAVE_MS, 'switch save');
      }
      if (!this.state.players.has(sessionId)) return;

      // 3. The profile being ENTERED, read from storage now.
      const resolved = accountId
        ? await profileStore.enterAccount(
            accountId,
            current.browserId,
            current.kind === 'guest' && current.key
              ? { key: current.key, profile: profileStore.snapshot(current.key, player) }
              : null,
          )
        : await profileStore.enterGuest(current.browserId, verification?.status ?? 'none');
      if (!this.state.players.has(sessionId)) return;

      // 4. Apply.
      this.adopt(client, player, resolved);
      logger.info(
        SCOPE,
        `switch ${sessionId}: ${describeIdentity(current)} -> ${describeIdentity(resolved.identity)}` +
          `${resolved.migrated ? ' (migrated guest progress)' : ''} ` +
          `level=${player.level} wins=${player.wins}`,
      );
    } catch (error) {
      logger.warn(
        SCOPE,
        `switch ${sessionId} abandoned, staying as ${describeIdentity(current)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Put a resolved profile onto a live player, in `onJoin`'s order.
   *
   * The portal NAME and portrait are kept from the live session rather than
   * the stored profile: they are the portal's current truth about who is
   * sitting at this keyboard, and the client sends a fresh one on every login
   * change anyway.
   */
  private adopt(client: Client, player: PlayerState, resolved: Resolved): void {
    const sessionId = client.sessionId;
    const displayName = player.displayName;
    const avatarUrl = player.avatarUrl;

    // Back to a fresh player's progression before restoring, so a switch to
    // an empty profile does not keep what the previous one had.
    const fresh = new PlayerState();
    player.totalSpeed = fresh.totalSpeed;
    player.wins = fresh.wins;
    player.ownedRobots = fresh.ownedRobots;
    player.rebirths = fresh.rebirths;
    player.ownedTrails = fresh.ownedTrails;
    player.trailSlot = fresh.trailSlot;
    player.bestStage = fresh.bestStage;

    const restored = profileStore.restore(resolved.profile, player);
    player.displayName = displayName;
    player.avatarUrl = avatarUrl;

    const previous = this.identities.get(sessionId);
    const identity = resolved.identity;
    this.identities.set(sessionId, identity);
    if (identity.key) this.playerIds.set(sessionId, identity.key);
    else this.playerIds.delete(sessionId);
    if (previous?.key && previous.key !== identity.key && !this.keyInUse(previous.key)) {
      profileStore.forget(previous.key);
    }

    this.movement.initialise(player);
    this.robots.initialise(player);
    this.trails.initialise(player);
    this.speeds.initialise(player);
    this.stages.initialise(sessionId);
    this.rebirths.sync(player);
    if (restored) this.speeds.syncDerived(player);

    this.placeAt(client, player, 'join');
    if (identity.key) void profileStore.save(identity.key, player);
    if (identity.kind === 'account') void this.applyGrantsAfterSwitch(sessionId);
  }

  /**
   * `applyGrants` refuses a session mid-switch, and `adopt` runs INSIDE the
   * switch - so the purchases wait for the switch to finish rather than being
   * skipped until the next poll.
   */
  private async applyGrantsAfterSwitch(sessionId: string): Promise<void> {
    while (this.switching.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.applyGrants(sessionId);
  }

  /**
   * Ask Bloxity again later, for a session whose token it could not check.
   *
   * Never a permanent demotion: the session plays on as it is meanwhile, and
   * the first successful check switches it to the account in place.
   */
  private scheduleReverify(client: Client): void {
    const sessionId = client.sessionId;
    const token = this.tokens.get(sessionId);
    if (!token) return;
    const previous = this.reverify.get(sessionId);
    if (previous) clearTimeout(previous.timer);
    const attempt = (previous?.attempt ?? 0) + 1;
    const seconds = REVERIFY_SECONDS[Math.min(attempt - 1, REVERIFY_SECONDS.length - 1)] ?? 300;
    const timer = setTimeout(() => {
      const pending = this.reverify.get(sessionId);
      if (pending) this.reverify.set(sessionId, { ...pending, timer: undefined });
      if (!this.identities.has(sessionId)) return;
      const latest = this.tokens.get(sessionId);
      if (latest) this.onAuthToken(client, { token: latest });
    }, seconds * 1000);
    this.reverify.set(sessionId, { attempt, timer });
    logger.info(SCOPE, `Bloxity unavailable for ${sessionId}; re-verifying in ${seconds}s`);
  }

  private cancelReverify(sessionId: string): void {
    const pending = this.reverify.get(sessionId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.reverify.delete(sessionId);
  }

  /** Is any session in this room on this storage key? */
  private keyInUse(key: string): boolean {
    for (const identity of this.identities.values()) if (identity.key === key) return true;
    return false;
  }

  private persist(sessionId: string, player: PlayerState): void {
    // Blocked mid-switch: the profile under this session is being replaced,
    // and a save now would write one profile's state into the other's key.
    if (this.switching.has(sessionId)) return;
    const key = this.identities.get(sessionId)?.key;
    if (key) void profileStore.save(key, player);
  }
}

/** A log-safe description of who a session is. Never the token. */
const describeIdentity = (identity: Identity): string => {
  if (identity.kind === 'account') return `account ${identity.key}`;
  if (identity.kind === 'guest') {
    return `guest ${identity.key}${identity.verification === 'unavailable' ? ' (bloxity unavailable)' : ''}`;
  }
  return 'ephemeral guest';
};

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
