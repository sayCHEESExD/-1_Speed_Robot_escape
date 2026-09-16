import type { AvatarAppearance, AvatarProportions } from './avatar.js';

/**
 * Client -> server input (MessageType.Move).
 *
 * INPUT ONLY. There is deliberately no position, velocity or rotation here:
 * the server simulates movement from intent and owns the result, so a client
 * has no channel through which to assert where it is.
 *
 * `seq` lets the server tell the client which inputs it has consumed, which is
 * what makes client-side prediction reconcilable.
 */
export interface MoveMessage {
  /** Monotonically increasing input sequence number. */
  seq: number;
  /** Seconds this input covers. Clamped and rate-limited server-side. */
  dt: number;
  /** -1..1, camera-relative. */
  moveX: number;
  /** -1..1, camera-relative. */
  moveZ: number;
  /** The jump key, held. Only a fresh PRESS produces a leap. */
  jump: boolean;
  /** Yaw the camera faced, so movement is camera-relative. */
  cameraYaw: number;
}

/** Why a run ended. */
export type RespawnReason =
  /** Fell out of the world, or into the glowing lava below it. */
  | 'fell'
  /** Hit a spike, a moving hazard or the hangar sentinel. */
  | 'hazard'
  /** Asked to be put back. */
  | 'manual'
  /** Just joined. */
  | 'join'
  /** Banked a stage and was returned to the arena. */
  | 'stage'
  /** Rebirthed, which resets the run as well as the level curve. */
  | 'rebirth';

/** Server -> client authoritative respawn (MessageType.Respawn). */
export interface RespawnMessage {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  reason: RespawnReason;
}

/**
 * Client -> server: "I reached this stage's finish pad."
 *
 * A request, never a grant. The server checks the stage index, the position it
 * has itself simulated, and whether this stage is already banked for the
 * current visit, then awards the Wins itself.
 */
export interface ClaimStageMessage {
  stageIndex: number;
}

/**
 * Client -> server: "I landed on this robot's stand, give it to me."
 *
 * A request, never a grant. The server checks the slot, the player's Wins and
 * that they are actually standing at that stand.
 */
export interface ClaimRobotMessage {
  slot: number;
}

/** Server -> client: a stage reward landed. Presentation only. */
export interface StageAwardedMessage {
  stageIndex: number;
  wins: number;
  /** Wins the player now holds, so the HUD can pop without waiting a patch. */
  total: number;
}

/**
 * Client -> server: "rebirth me".
 *
 * Deliberately empty. The server knows the level and the rebirth count, and it
 * is the only thing allowed to decide whether the requirement is met - so
 * there is nothing in this message that could be wrong.
 */
export type RebirthMessage = Record<string, never>;

/** Client -> server: buy the trail in this slot. A request, never a grant. */
export interface BuyTrailMessage {
  slot: number;
}

/** Client -> server: wear an owned trail, or 0 to take it off. */
export interface EquipTrailMessage {
  slot: number;
}

/**
 * Client -> server: the player's Bloxity appearance.
 *
 * Sent on join and again whenever the portal reports a change, so a player who
 * re-dresses mid-run is re-drawn for everyone without a reload.
 */
export interface SetAvatarMessage {
  appearance: AvatarAppearance;
  proportions: AvatarProportions;
}
