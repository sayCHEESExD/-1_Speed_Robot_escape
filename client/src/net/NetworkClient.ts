import {
  MessageType,
  ROOM_NAME,
  type ClaimRobotMessage,
  type ClaimStageMessage,
  type MoveMessage,
  type RespawnMessage,
  type SetAvatarMessage,
  type SetIdentityMessage,
  type StageAwardedMessage,
} from '@robot/shared';
import { Client, getStateCallbacks, type Room } from 'colyseus.js';
import { clientConfig } from '../config/clientConfig.js';
import { logger } from '../util/logger.js';
import type {
  ConnectionStatus,
  LeaderboardSnapshot,
  NetCourseState,
  NetLeaderEntry,
  NetPlayerState,
} from './netTypes.js';

const SCOPE = 'NetworkClient';

/** Key under which this browser's stable player id is kept. */
const PLAYER_ID_KEY = 'robotobby.playerId';

/**
 * Backoff between join attempts, in milliseconds. One entry per RETRY.
 *
 * A free managed host suspends an idle service and takes the better part of a
 * minute to wake it, so the first visitor after a quiet spell always meets a
 * server that is not listening yet. A single attempt turns that into a session
 * that is permanently offline - it renders and it moves, so it looks healthy,
 * but nothing is server-authoritative and therefore nothing progresses. These
 * retries turn a cold start into a slow start instead.
 */
const JOIN_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A stable id for this browser, so progression survives a reload.
 *
 * Falls back to a throwaway id when storage is unavailable (private windows,
 * blocked site data) - the session still works, it just will not be restored.
 */
const resolvePlayerId = (): string => {
  const fresh = `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    const existing = window.localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    window.localStorage.setItem(PLAYER_ID_KEY, fresh);
  } catch {
    return fresh;
  }
  return fresh;
};

/** Everything the game needs to react to. Kept deliberately small. */
export interface NetworkHandlers {
  onStatusChange?(status: ConnectionStatus, detail?: string): void;
  onSelfJoined?(sessionId: string): void;
  onPlayerAdded?(sessionId: string, player: NetPlayerState): void;
  onPlayerChanged?(sessionId: string, player: NetPlayerState): void;
  onPlayerRemoved?(sessionId: string): void;
  onRespawn?(message: RespawnMessage): void;
  onStageAwarded?(message: StageAwardedMessage): void;
}

/**
 * Thin wrapper over colyseus.js.
 *
 * The rest of the client never imports colyseus.js directly - swapping the
 * transport or the room name only touches this file and @robot/shared.
 */
export class NetworkClient {
  private readonly handlers: NetworkHandlers;

  /**
   * Built on CONNECT, not on construction.
   *
   * Colyseus parses the endpoint in its own constructor, so building this
   * eagerly meant a build with no server configured threw while the `Game` was
   * still being assembled - long before anything could report why. The whole
   * game then failed to start with "Invalid URL", which says nothing at all
   * about the actual cause: nobody set `VITE_SERVER_URL`.
   */
  private client: Client | null = null;

  private room: Room<NetCourseState> | null = null;
  private status: ConnectionStatus = 'idle';

  /**
   * Who this browser is on Bloxity, asked at join time.
   *
   * A CALLBACK rather than a stored id: the account can change between one
   * join and the next, and a value captured at construction would send the
   * previous player's id after a logout. Kept as a plain function so `net/`
   * still imports nothing from the portal layer.
   */
  private identity: (() => string | null) | null = null;

  /**
   * The local player's Bloxity look, asked for at JOIN time.
   *
   * A provider rather than a stored value, for the same reason `Bloxity` never
   * caches the user: the avatar can change between a disconnect and the
   * reconnect that follows, and a value captured early would re-join wearing
   * whatever was equipped when the page loaded.
   */
  private look: (() => SetAvatarMessage | null) | null = null;

  /**
   * Who the player is, asked for at JOIN time.
   *
   * A provider for the same reason as the look: a player can sign in between a
   * disconnect and the reconnect that follows, and a value captured early
   * would re-join under the previous name - or under none.
   */
  private identityOf: (() => SetIdentityMessage) | null = null;

  constructor(handlers: NetworkHandlers = {}) {
    this.handlers = handlers;
  }

  /** Where the room should get the Bloxity account id from, if there is one. */
  setLookProvider(provider: () => SetAvatarMessage | null): void {
    this.look = provider;
  }

  /**
   * Tell the room what the player looks like.
   *
   * Cosmetic, and the server treats it as such - it is sanitised and
   * replicated, never trusted for anything that decides an outcome.
   */
  sendAvatar(message: SetAvatarMessage): void {
    this.room?.send(MessageType.SetAvatar, message);
  }

  /**
   * Tell the room who the player IS: their portal display name and portrait.
   *
   * Cosmetic in exactly the way the avatar is - the server sanitises it and
   * replicates it, and nothing that decides an outcome reads it. The account
   * id goes separately, on the join options, and stays on the server.
   */
  sendIdentity(message: SetIdentityMessage): void {
    this.room?.send(MessageType.SetIdentity, message);
  }

  setIdentityProvider(provider: () => string | null): void {
    this.identity = provider;
  }

  /** Where the room should get the player's display name and portrait from. */
  setDisplayProvider(provider: () => SetIdentityMessage): void {
    this.identityOf = provider;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /**
   * The Colyseus room id, or '' when not in one.
   *
   * Exposed for the portal, which uses it as the join target for a friend
   * invite. A string rather than the room itself: the room object is this
   * class's business and nothing outside `net/` should be able to send on it.
   */
  get roomId(): string {
    return this.room?.roomId ?? '';
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * The server's clock, in seconds.
   *
   * The moving hazards are a pure function of it, so this is what the client
   * evaluates `hazardXAt` against - which is why the sphere on screen is in
   * the same place as the one the server will kill you with.
   */
  get elapsed(): number {
    return this.room?.state?.elapsed ?? 0;
  }

  async connect(): Promise<void> {
    // No endpoint is a CONFIGURATION fault, not a network one, and it is
    // reported as one before a socket is ever attempted. On a static host this
    // is far and away the likeliest thing to be wrong.
    if (!clientConfig.serverUrl) {
      this.setStatus('error');
      throw new Error(
        'No game server is configured. Set VITE_SERVER_URL to the Colyseus ' +
          'endpoint (for example wss://your-server-host) and rebuild.',
      );
    }

    this.setStatus('connecting');
    logger.info(SCOPE, `joining "${ROOM_NAME}" at ${clientConfig.serverUrl}`);

    this.client ??= new Client(clientConfig.serverUrl);
    const playerId = resolvePlayerId();
    const attempts = JOIN_BACKOFF_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.room = await this.client.joinOrCreate<NetCourseState>(ROOM_NAME, {
          playerId,
          // Optional: a signed-out player simply has none, and the room falls
          // back to the browser-stored id exactly as it always did.
          bloxityId: this.identity?.() ?? undefined,
          // Sent with the join rather than after it, so players already in the
          // room draw this one correctly from their very first patch.
          avatar: this.look?.() ?? undefined,
          // Same reasoning as the avatar: everyone already in the room should
          // see this player's NAME in the first patch, not a handle that is
          // replaced a round trip later.
          identity: this.identityOf?.() ?? undefined,
        });
        break;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(SCOPE, `join attempt ${attempt}/${attempts} failed: ${detail}`);

        if (attempt === attempts) {
          this.setStatus('error', detail);
          logger.error(SCOPE, 'join failed:', detail);
          throw error;
        }

        // Kept in 'connecting' with the attempt as the detail, so the status
        // listener sees a wake-up in progress rather than a dead connection.
        this.setStatus('connecting', `attempt ${attempt + 1}/${attempts}`);
        await sleep(JOIN_BACKOFF_MS[attempt - 1] ?? 0);
      }
    }

    if (!this.room) throw new Error('join produced no room');

    this.bindRoom(this.room);
    this.setStatus('connected');
    logger.info(
      SCOPE,
      `joined roomId=${this.room.roomId} sessionId=${this.room.sessionId}`,
    );
    this.handlers.onSelfJoined?.(this.room.sessionId);
  }

  /**
   * Report one simulated input.
   *
   * Deliberately NOT rate limited. The client simulates on a fixed 60Hz step
   * and the server advances only by the inputs it receives, so throttling here
   * would leave the authoritative position permanently behind the player. The
   * message is seven small fields.
   */
  sendInput(message: MoveMessage): void {
    this.room?.send(MessageType.Move, message);
  }

  /** Ask the server to bank a stage. The server decides; this never grants. */
  claimStage(stageIndex: number): void {
    const message: ClaimStageMessage = { stageIndex };
    this.room?.send(MessageType.ClaimStage, message);
  }

  /** Ask the server for an robot. The server takes the payment. */
  claimRobot(slot: number): void {
    const message: ClaimRobotMessage = { slot };
    this.room?.send(MessageType.ClaimRobot, message);
  }

  /**
   * Ask to rebirth.
   *
   * Carries nothing: the server knows the level and the rebirth count and is
   * the only thing allowed to decide whether the requirement is met.
   */
  requestRebirth(): void {
    this.room?.send(MessageType.Rebirth, {});
  }

  /** Ask to buy a trail. The server decides and replicates the result. */
  buyTrail(slot: number): void {
    this.room?.send(MessageType.BuyTrail, { slot });
  }

  /** Ask to wear an owned trail, or 0 to take it off. */
  equipTrail(slot: number): void {
    this.room?.send(MessageType.EquipTrail, { slot });
  }

  /** The replicated guardian, or null before the first patch. */
  get guardian(): { x: number; z: number; rotationY: number; charging: boolean } | null {
    const state = this.room?.state?.guardian;
    return state
      ? { x: state.x, z: state.z, rotationY: state.rotationY, charging: state.charging }
      : null;
  }

  /**
   * The three leaderboards, as plain arrays.
   *
   * COPIED out of the schema rather than handed over live. A live schema
   * reference reads as whatever it holds at the moment it is looked at, so a
   * renderer that kept one would silently start showing a later board than the
   * one it decided to redraw for - which is exactly the class of bug that
   * makes a display look like it is missing updates.
   */
  get leaderboard(): LeaderboardSnapshot | null {
    const board = this.room?.state?.leaderboard;
    if (!board) return null;
    const copy = (rows: ArrayLike<NetLeaderEntry>): NetLeaderEntry[] => {
      const out: NetLeaderEntry[] = [];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        // Name and portrait travel with the row: a board draws a player it has
        // never seen in the room, so it cannot look either of them up.
        if (row) {
          out.push({
            handle: row.handle,
            name: row.name,
            avatarUrl: row.avatarUrl,
            value: row.value,
          });
        }
      }
      return out;
    };
    return { wins: copy(board.wins), speed: copy(board.speed), rebirths: copy(board.rebirths) };
  }

  /**
   * Ask to be put back at the starting arena.
   *
   * A request with no payload. The server decides where a respawn lands and
   * replies with the authoritative `Respawn`, so this can no more move a
   * player than a stage claim can pay one.
   */
  requestRespawn(): void {
    this.room?.send(MessageType.RequestRespawn, {});
  }

  async disconnect(): Promise<void> {
    await this.room?.leave(true);
    this.room = null;
    this.setStatus('disconnected');
  }

  private bindRoom(room: Room<NetCourseState>): void {
    const $ = getStateCallbacks(room);

    $(room.state).players.onAdd((player, sessionId) => {
      this.handlers.onPlayerAdded?.(sessionId, player);
      $(player).onChange(() => {
        this.handlers.onPlayerChanged?.(sessionId, player);
      });
      // A NESTED schema's changes do not bubble to its parent, so the avatar
      // needs a listener of its own: without one a player who re-dressed
      // mid-run kept their old body on everybody else's screen until they
      // moved far enough to touch a field on `player` itself. Both paths hand
      // back the same `player`, so the receiving end cannot tell which fired.
      $(player.avatar).onChange(() => {
        this.handlers.onPlayerChanged?.(sessionId, player);
      });
    });

    $(room.state).players.onRemove((_player, sessionId) => {
      this.handlers.onPlayerRemoved?.(sessionId);
    });

    room.onMessage<RespawnMessage>(MessageType.Respawn, (message) => {
      this.handlers.onRespawn?.(message);
    });

    room.onMessage<StageAwardedMessage>(MessageType.StageAwarded, (message) => {
      this.handlers.onStageAwarded?.(message);
    });

    room.onError((code, message) => {
      logger.error(SCOPE, `room error ${code}: ${message ?? ''}`);
      this.setStatus('error', message);
    });

    room.onLeave((code) => {
      logger.warn(SCOPE, `left room (code ${code})`);
      this.setStatus('disconnected', `code ${code}`);
    });
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatusChange?.(status, detail);
  }
}
