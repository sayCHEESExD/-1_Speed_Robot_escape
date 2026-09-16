import { LEADERBOARD_SIZE, handleFor } from '@robot/shared';
import type { LeaderEntry, LeaderboardState } from '../rooms/state/CourseState.js';
import type { PlayerState } from '../rooms/state/PlayerState.js';
import { profileStore } from './ProfileStore.js';

/** Seconds between rebuilds. A board is not a thing that needs 20 Hz. */
const REFRESH_SECONDS = 2;

/** One candidate, before it is ranked. */
interface Candidate {
  readonly handle: string;
  /** The portal's display name, or empty for a player who has never signed in. */
  readonly name: string;
  /** Their portrait on the portal's CDN, or empty. */
  readonly avatarUrl: string;
  readonly wins: number;
  readonly speed: number;
  readonly rebirths: number;
}

/**
 * The three boards on the spawn wall.
 *
 * Every figure is the SERVER's. Clients are never asked what their totals are
 * and could not usefully lie if they were: the numbers come from the same
 * `PlayerState` the rewards are paid into, and from the profile store for
 * everyone who is not currently connected.
 *
 * Merging those two is the whole job. A live player's state is fresher than
 * their saved profile - Speed accrues continuously and is only written out
 * every few seconds - so the live figure wins wherever both exist, or a player
 * would watch the board show a total they passed a minute ago.
 *
 * Rebuilt on a timer rather than per tick. Sorting every profile on the server
 * twenty times a second to feed a sign on a wall would be the most expensive
 * thing in the room, and nobody can read it that fast.
 */
export class LeaderboardService {
  private timer = 0;

  /** Rebuild if it is time. Returns true when the state was rewritten. */
  update(
    delta: number,
    board: LeaderboardState,
    live: Iterable<[string, PlayerState]>,
    playerIds: ReadonlyMap<string, string>,
  ): boolean {
    this.timer -= delta;
    if (this.timer > 0) return false;
    this.timer = REFRESH_SECONDS;
    this.rebuild(board, live, playerIds);
    return true;
  }

  /** Force a rebuild now, e.g. the moment someone banks a stage. */
  rebuild(
    board: LeaderboardState,
    live: Iterable<[string, PlayerState]>,
    playerIds: ReadonlyMap<string, string>,
  ): void {
    const byHandle = new Map<string, Candidate>();

    for (const [id, profile] of profileStore.entries()) {
      // Stored players: most of a board is people who are not in the room, and
      // the name they were last seen under is saved with their progression so
      // they do not revert to a generated handle the moment they log out.
      byHandle.set(handleFor(id), {
        handle: handleFor(id),
        name: profile.displayName ?? '',
        avatarUrl: profile.avatarUrl ?? '',
        wins: profile.wins,
        speed: profile.totalSpeed,
        rebirths: profile.rebirths,
      });
    }

    // Live state last, so it overwrites the stored copy of the same player.
    for (const [sessionId, player] of live) {
      const id = playerIds.get(sessionId);
      if (!id) continue;
      const handle = handleFor(id);
      byHandle.set(handle, {
        handle,
        name: player.displayName,
        avatarUrl: player.avatarUrl,
        wins: player.wins,
        speed: player.totalSpeed,
        rebirths: player.rebirths,
      });
    }

    const all = [...byHandle.values()];
    fill(board.wins, all, (c) => c.wins);
    fill(board.speed, all, (c) => c.speed);
    fill(board.rebirths, all, (c) => c.rebirths);
  }
}

/**
 * Rank by one field and write the top N into a replicated array.
 *
 * The array is REUSED rather than rebuilt: Colyseus sends a patch per changed
 * field, and clearing an array of nine and pushing nine fresh entries every two
 * seconds would send the whole board to every client whether or not anything
 * about it had moved.
 */
const fill = (
  into: LeaderEntry[] & { push(entry: LeaderEntry): unknown },
  all: readonly Candidate[],
  pick: (candidate: Candidate) => number,
): void => {
  const ranked = all
    .filter((candidate) => pick(candidate) > 0)
    .sort((a, b) => pick(b) - pick(a))
    .slice(0, LEADERBOARD_SIZE);

  for (let i = 0; i < LEADERBOARD_SIZE; i += 1) {
    const entry = into[i];
    if (!entry) continue;
    const candidate = ranked[i];
    const handle = candidate ? candidate.handle : '';
    const name = candidate ? candidate.name : '';
    const avatarUrl = candidate ? candidate.avatarUrl : '';
    const value = candidate ? Math.floor(pick(candidate)) : 0;
    // Assign only on a real change, for the same reason as above: an identical
    // write still counts as a change to the schema encoder.
    if (entry.handle !== handle) entry.handle = handle;
    if (entry.name !== name) entry.name = name;
    if (entry.avatarUrl !== avatarUrl) entry.avatarUrl = avatarUrl;
    if (entry.value !== value) entry.value = value;
  }
};

export const leaderboardService = new LeaderboardService();
