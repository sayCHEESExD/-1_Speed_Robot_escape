import type { AvatarAppearance, AvatarProportions } from '@robot/shared';
import type { RobotAnimationState, PlayerMotionState } from '@robot/shared';
import type { MapSchema } from '@colyseus/schema';

/**
 * Client-side TYPE mirror of the server's Colyseus schema.
 *
 * These are types only - colyseus.js builds the concrete schema instances at
 * runtime from the handshake reflection, so there is no duplicated schema
 * class to keep in sync, only this shape.
 */
export interface NetPlayerState extends PlayerMotionState {
  sessionId: string;
  /**
   * The portal display name, replicated so every client can draw every player.
   *
   * EMPTY for a player who is not signed in: `visibleName` in shared is the
   * one place that decides what to show instead, so a guest is called the same
   * thing on every screen.
   */
  displayName: string;
  /** Their portrait on the portal's CDN, or empty. */
  avatarUrl: string;
  /** The ROBOT's transform. The rider is carried and has none of its own. */
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animation: RobotAnimationState;

  level: number;
  rebirths: number;
  wins: number;
  totalSpeed: number;
  robotSlot: number;
  ownedRobots: number;
  speedPerStep: number;
  moveMultiplier: number;
  jumpVelocity: number;
  maxLevel: number;
  bestStage: number;

  /** Authoritative velocity, used to reconcile client prediction. */
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** Highest input sequence the server has simulated. */
  lastInputSeq: number;
  /** Bitmask of trails bought, and the one worn. Server-owned. */
  ownedTrails: number;
  trailSlot: number;
  /** Latched jump edge, so replay resumes from the server's own edge state. */
  jumpLatched: boolean;
  /** Coyote window left, so a replayed jump off a lip is allowed identically. */
  coyote: number;
  ready: boolean;

  /**
   * How this player looks in the Bloxity portal.
   *
   * The only replicated field that began life on a client, and the only one
   * that decides nothing: it chooses meshes and a texture. See
   * `shared/src/types/avatar.ts`.
   */
  avatar: AvatarAppearance & AvatarProportions;
}

/** The replicated guardian. The one hazard that is state, not a formula. */
export interface NetGuardianState {
  x: number;
  z: number;
  rotationY: number;
  charging: boolean;
}

/** One row of one leaderboard, exactly as the server ranked it. */
export interface NetLeaderEntry {
  /** The derived fallback. Empty means an empty row; never shown as a name. */
  handle: string;
  /** The portal display name, when the player has one. This is what is drawn. */
  name: string;
  /** Their portrait on the portal's CDN, drawn beside the name. */
  avatarUrl: string;
  value: number;
}

/** The three boards on the spawn wall. Read-only, and entirely the server's. */
export interface NetLeaderboardState {
  wins: ArrayLike<NetLeaderEntry>;
  speed: ArrayLike<NetLeaderEntry>;
  rebirths: ArrayLike<NetLeaderEntry>;
}

export interface NetCourseState {
  players: MapSchema<NetPlayerState>;
  /** The clock the moving hazards are a pure function of. */
  elapsed: number;
  guardian: NetGuardianState;
  leaderboard: NetLeaderboardState;
}

/** A leaderboard flattened into plain data, ready to draw. */
export interface LeaderboardSnapshot {
  wins: readonly NetLeaderEntry[];
  speed: readonly NetLeaderEntry[];
  rebirths: readonly NetLeaderEntry[];
}

/** Connection lifecycle, surfaced to the UI. */
export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';
