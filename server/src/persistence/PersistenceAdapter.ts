/**
 * Everything worth keeping about a player between sessions.
 *
 * Deliberately the DERIVING facts only: level, movement speed and the equipped
 * robot are all recomputed from these on load through the same formulas a
 * live session uses, so a tuning change reaches returning players too.
 */
export interface StoredProfile {
  /** Lifetime Speed farmed. Level follows from it. */
  totalSpeed: number;
  /** Stage wins banked. */
  wins: number;
  /** Bitmask of robots claimed. The equipped one is the best of these. */
  ownedRobots: number;
  /** Rebirths performed. */
  rebirths: number;
  /** Bitmask of trails bought, and the one worn. Permanent unlocks. */
  ownedTrails: number;
  trailSlot: number;
  /** Highest stage ever finished. */
  bestStage: number;
  /**
   * The portal's display name and portrait as last seen.
   *
   * Stored so a board can name a player who is NOT in the room: the top of the
   * Wins board is mostly people who are offline, and reading their id back as
   * a generated handle after they had a name would rename them every time they
   * logged out. Optional, because every profile written before this existed
   * has neither.
   */
  displayName?: string;
  avatarUrl?: string;
  /** Wall clock of the last save, for diagnostics and future pruning. */
  updatedAt: number;
}

/**
 * Where profiles live.
 *
 * Nothing above this boundary knows whether that is a JSON file, a database or
 * nothing at all - `createPersistence` is the ONLY place that names a concrete
 * adapter.
 */
export interface PersistenceAdapter {
  /** Read everything into memory. Called once, before the server listens. */
  load(): Map<string, StoredProfile>;
  /** Queue a write. Implementations may debounce. */
  save(profiles: Map<string, StoredProfile>): void;
  /** Make any pending write durable. Called on shutdown. */
  flush(): void;
}
