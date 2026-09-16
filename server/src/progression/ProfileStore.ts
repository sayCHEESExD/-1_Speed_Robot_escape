import { INITIAL_OWNED_ROBOTS } from '@robot/shared';
import { createPersistence, type PersistenceAdapter, type StoredProfile } from '../persistence/index.js';
import type { PlayerState } from '../rooms/state/PlayerState.js';

/**
 * Progression that outlives a session.
 *
 * A CACHE in front of a durable adapter, not the only copy: a room dies with
 * its last client, so the store is process-wide, and the adapter is what makes
 * a server RESTART survivable rather than just a reconnect.
 *
 * Keyed by a browser-stored player id. Two tabs in one browser therefore share
 * a profile, which is the correct behaviour - they are one player.
 */
class ProfileStore {
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly adapter: PersistenceAdapter = createPersistence();
  private opened = false;

  /** Read everything into memory. Call once, before the server listens. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    for (const [id, profile] of this.adapter.load()) this.profiles.set(id, profile);
  }

  get size(): number {
    return this.profiles.size;
  }

  /**
   * Every stored profile, id and all.
   *
   * For the leaderboard, which has to be able to show players who are not
   * currently connected - a board that emptied when the server did would say
   * nothing about anybody's progress.
   */
  entries(): IterableIterator<[string, StoredProfile]> {
    return this.profiles.entries();
  }

  /**
   * Apply a stored profile onto fresh player state.
   *
   * Only the DERIVING facts are restored. Level, movement speed, jump velocity
   * and the equipped robot are all recomputed by their own services from
   * these, so returning players get the current tuning rather than a snapshot
   * of whatever it was when they left.
   */
  restore(playerId: string, player: PlayerState): boolean {
    const profile = this.profiles.get(playerId);
    if (!profile) return false;

    player.totalSpeed = profile.totalSpeed;
    player.wins = profile.wins;
    // A profile saved before the roster existed owns nothing; the starter is
    // free, so it is always granted rather than leaving the player unmounted.
    player.ownedRobots = profile.ownedRobots | INITIAL_OWNED_ROBOTS;
    player.rebirths = profile.rebirths;
    player.ownedTrails = profile.ownedTrails;
    player.trailSlot = profile.trailSlot;
    player.bestStage = profile.bestStage;
    return true;
  }

  /** Write the player's current progression back to the cache and the disk. */
  save(playerId: string, player: PlayerState): void {
    if (!playerId) return;
    this.profiles.set(playerId, {
      totalSpeed: player.totalSpeed,
      wins: player.wins,
      ownedRobots: player.ownedRobots,
      rebirths: player.rebirths,
      ownedTrails: player.ownedTrails,
      trailSlot: player.trailSlot,
      bestStage: player.bestStage,
      updatedAt: Date.now(),
    });
    this.adapter.save(this.profiles);
  }

  /** Make any pending write durable. Called on shutdown. */
  flush(): void {
    this.adapter.flush();
  }
}

/**
 * Process-wide singleton.
 *
 * A room dies with its last client, so per-room storage would lose a player's
 * progression the moment they were briefly alone and disconnected.
 */
export const profileStore = new ProfileStore();
