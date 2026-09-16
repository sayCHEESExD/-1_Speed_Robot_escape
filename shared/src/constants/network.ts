/**
 * Network-level constants. Must stay identical on client and server.
 */

/** Colyseus room registered by the server and joined by the client. */
export const ROOM_NAME = 'robotescape';

/**
 * Default server port. Override with the PORT env var on the server.
 *
 * Deliberately NOT 2567: that is the Colyseus default and the previous game in
 * this series already answers on it, so sharing it would mean whichever server
 * started first silently served both clients.
 */
export const DEFAULT_SERVER_PORT = 2573;

/**
 * Most players in ONE room.
 *
 * The matchmaker locks a room at this figure and opens another, so a
 * sixteenth player gets a new room rather than a refusal - which is what
 * "routed, not rejected" means here.
 *
 * It lives in `shared/` because it is a fact about the world both halves have
 * to agree on: the server enforces it, and anything the client ever shows
 * about how full a room is has to be the same number or it is lying.
 */
export const MAX_PLAYERS_PER_ROOM = 15;

/**
 * How many OTHER players are drawn at once.
 *
 * TWO, and the pair is always the two closest to the local player - see
 * `RemotePlayerManager`. Everyone in the room is still tracked and still
 * synchronised on every patch; this is a RENDERING limit and nothing else.
 *
 * It is two because of what a player costs to draw here. A mech is a couple of
 * dozen meshes, it carries a dressed Bloxity avatar with its own skeleton, and
 * it trails a ribbon - and a room of fifteen of those is most of a phone's
 * frame budget spent on players too far away to make out. Drawing the nearest
 * two keeps the people you are actually next to, which is the only place
 * another player affects how this game feels.
 *
 * It lives in `shared/` beside the room capacity because the two are read
 * together: the capacity says how many can be HERE and this says how many can
 * be SEEN, and a change to either without the other in view is how a room ends
 * up feeling empty.
 */
export const VISIBLE_REMOTE_PLAYERS = 2;

/** Server simulation / state broadcast rate, in Hz. */
export const SERVER_TICK_RATE = 20;

/** Milliseconds between server ticks. */
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Client->server and server->client message identifiers.
 *
 * A const object rather than an enum so it survives `verbatimModuleSyntax` and
 * erases cleanly in both build pipelines.
 */
export const MessageType = {
  /** Client -> server: one frame of INPUT. Never a transform. */
  Move: 'move',
  /** Server -> client: authoritative respawn instruction. */
  Respawn: 'respawn',
  /** Client -> server: "I think I finished a stage." A request, never a grant. */
  ClaimStage: 'claimStage',
  /** Client -> server: "I am standing on this robot's stand, claim it." */
  ClaimRobot: 'claimRobot',
  /** Client -> server: "put me back at the starting arena". */
  RequestRespawn: 'requestRespawn',
  /** Server -> client: a stage reward was granted. Drives the celebration. */
  StageAwarded: 'stageAwarded',
  /**
   * Client -> server: "rebirth me".
   *
   * Carries nothing: the server already knows the player's level and rebirth
   * count, and it is the only thing allowed to decide whether the requirement
   * is met.
   */
  Rebirth: 'rebirth',
  /** Client -> server: buy the trail in this slot. */
  BuyTrail: 'buyTrail',
  /** Client -> server: wear an OWNED trail, or 0 to take it off. */
  EquipTrail: 'equipTrail',
  /**
   * Client -> server: "this is what my Bloxity avatar looks like".
   *
   * The one message whose content the server stores rather than judges, and it
   * can be because it decides nothing: the portal owns a player's appearance
   * and the server has no way to ask it, so the client is the only source
   * there is. It is sanitised on arrival and it never touches progression.
   */
  SetAvatar: 'setAvatar',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];
