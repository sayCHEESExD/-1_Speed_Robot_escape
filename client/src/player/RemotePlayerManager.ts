import { VISIBLE_REMOTE_PLAYERS } from '@robot/shared';
import type { Scene, Vector3 } from 'three';
import type { NetPlayerState } from '../net/netTypes.js';
import { RemotePlayer } from './RemotePlayer.js';

/**
 * Seconds between two re-rankings of who is closest.
 *
 * Not per frame, deliberately. Distance ordering changes on the scale of
 * seconds, and re-sorting the room sixty times a second to answer a question
 * whose answer moves at walking pace is the kind of cost that only shows up on
 * a phone. The ranking is also re-run IMMEDIATELY whenever somebody joins or
 * leaves, so a new arrival never waits a third of a second to appear.
 */
const RANK_INTERVAL = 0.3;

/**
 * How much closer a hidden player must be before they take a visible player's
 * slot, in world units.
 *
 * Pure HYSTERESIS, and the whole reason the swap is watchable. Two mechs
 * running side by side are constantly a few units either side of each other,
 * and a strict "closest two wins" would pop one in and the other out several
 * times a second. A margin means a swap happens once, when somebody has
 * genuinely overtaken.
 */
const SWAP_MARGIN = 24;

/**
 * Every other player in the room.
 *
 * A registry, and a VISIBILITY POLICY. It owns the lifetime of each
 * `RemotePlayer` and decides which of them are in the scene; all the
 * reconstruction lives in `RemotePlayer`, so a remote mech is animated by
 * exactly the code the local one is.
 *
 * THE CLOSEST-PLAYER RULE, and it is the one thing this class does that a
 * plain map would not:
 *
 *  - Every remote in the room is TRACKED. `apply` runs for all of them on
 *    every patch, so their position, progression, avatar, mech and trail are
 *    always current. Nothing about the synchronisation is reduced.
 *  - Only the `VISIBLE_REMOTE_PLAYERS` nearest the local player are DRAWN and
 *    animated. A mech is a two-dozen-mesh model with a dressed Bloxity rider
 *    and a trail ribbon on top, and a room of fifteen of them is most of the
 *    frame budget on a phone - spent almost entirely on players too far away
 *    to make out.
 *
 * The distinction matters: this is a rendering limit, not a networking one. A
 * player who walks into view is already fully up to date, so they appear in
 * the right place doing the right thing on the frame they become visible -
 * there is no pop-in, no interpolation catch-up and no stale pose, which is
 * exactly what a system that stopped RECEIVING them would produce.
 */
export class RemotePlayerManager {
  private readonly players = new Map<string, RemotePlayer>();
  /** Who is currently in the scene. A subset of `players`, at most the limit. */
  private readonly visible = new Set<string>();
  private readonly scene: Scene;

  /** Seconds until the next re-ranking. */
  private sinceRank = RANK_INTERVAL;

  /** Scratch for the ranking, reused so a per-tick sort allocates nothing. */
  private readonly ranked: { id: string; distance: number }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** How many other players are in the room, drawn or not. */
  get count(): number {
    return this.players.size;
  }

  /** How many are actually on screen. At most `VISIBLE_REMOTE_PLAYERS`. */
  get drawnCount(): number {
    return this.visible.size;
  }

  add(sessionId: string, state: NetPlayerState): void {
    if (this.players.has(sessionId)) return;
    this.players.set(sessionId, new RemotePlayer(state));
    // Rank on the next frame rather than here: a join arrives before the
    // local player's position has been updated for this frame, and ranking
    // against a stale position is how the wrong two get picked.
    this.sinceRank = RANK_INTERVAL;
  }

  update(sessionId: string, state: NetPlayerState): void {
    // EVERY tracked player, visible or not. Their state stays current so that
    // becoming visible is a matter of adding nodes to the scene and nothing
    // else.
    this.players.get(sessionId)?.apply(state);
  }

  remove(sessionId: string): void {
    const player = this.players.get(sessionId);
    if (!player) return;
    this.hide(sessionId, player);
    player.dispose();
    this.players.delete(sessionId);
    this.sinceRank = RANK_INTERVAL;
  }

  /**
   * Advance the drawn players, and re-rank who those are.
   *
   * @param local the local player's RENDER position - the same vector the
   *              camera follows, so "closest" means closest to what is on
   *              screen rather than to a simulation state a frame behind.
   */
  advance(delta: number, local: Vector3 | null): void {
    this.sinceRank += Math.max(0, delta);
    if (this.sinceRank >= RANK_INTERVAL && local) {
      this.sinceRank = 0;
      this.rank(local);
    }

    for (const id of this.visible) {
      this.players.get(id)?.update(delta);
    }
  }

  dispose(): void {
    for (const [id, player] of this.players) {
      this.hide(id, player);
      player.dispose();
    }
    this.players.clear();
    this.visible.clear();
  }

  /**
   * Pick the nearest few and swap the scene over to them.
   *
   * Sorted rather than partially selected, because the room holds fifteen
   * players at most: a full sort of fifteen entries three times a second is
   * free, and a hand-rolled selection would be one more thing to get wrong for
   * no measurable gain.
   */
  private rank(local: Vector3): void {
    this.ranked.length = 0;
    for (const [id, player] of this.players) {
      const dx = player.position.x - local.x;
      const dy = player.position.y - local.y;
      const dz = player.position.z - local.z;
      this.ranked.push({ id, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }
    this.ranked.sort((a, b) => a.distance - b.distance);

    /*
     * Choose the winners, giving the incumbents a head start.
     *
     * A player already on screen counts as `SWAP_MARGIN` nearer than they are,
     * so a challenger has to genuinely overtake rather than merely tie. That
     * one subtraction is the difference between two mechs trading places once
     * and two mechs flickering at each other all the way down a stage.
     */
    const winners = new Set<string>();
    const scored = this.ranked.map((entry) => ({
      id: entry.id,
      score: this.visible.has(entry.id) ? entry.distance - SWAP_MARGIN : entry.distance,
    }));
    scored.sort((a, b) => a.score - b.score);
    for (const entry of scored) {
      if (winners.size >= VISIBLE_REMOTE_PLAYERS) break;
      winners.add(entry.id);
    }

    for (const id of [...this.visible]) {
      if (winners.has(id)) continue;
      const player = this.players.get(id);
      if (player) this.hide(id, player);
    }
    for (const id of winners) {
      if (this.visible.has(id)) continue;
      const player = this.players.get(id);
      if (player) this.show(id, player);
    }
  }

  private show(id: string, player: RemotePlayer): void {
    this.scene.add(player.mount.root);
    // The trail lives in world space, so it is added beside the mech rather
    // than under it.
    this.scene.add(player.mount.worldRoot);
    this.visible.add(id);
  }

  private hide(id: string, player: RemotePlayer): void {
    if (!this.visible.delete(id)) return;
    player.mount.root.removeFromParent();
    player.mount.worldRoot.removeFromParent();
    // The ribbon describes where they were while they were on screen; leaving
    // it would draw a line from there to wherever they are when they come
    // back.
    player.mount.trail.clear();
  }
}
