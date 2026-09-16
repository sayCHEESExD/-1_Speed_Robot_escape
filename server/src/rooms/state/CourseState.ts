import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import { LEADERBOARD_SIZE } from '@robot/shared';
import { PlayerState } from './PlayerState.js';

/** One row of one board: who, and how much. */
export class LeaderEntry extends Schema {
  /** Derived from the player's id on the server. Empty means an empty row. */
  @type('string') handle = '';
  @type('float64') value = 0;
}

/**
 * The three boards on the spawn wall.
 *
 * FIXED-LENGTH arrays, allocated once and written in place. A board is
 * rewritten every couple of seconds, and clearing and refilling nine entries
 * each time would send the whole thing to every client on every rebuild
 * whether or not a single place had actually changed.
 *
 * Everything in here is the server's own figure. No client is asked for its
 * totals, and none could usefully claim any: these come from the same state
 * the rewards are paid into.
 */
export class LeaderboardState extends Schema {
  @type([LeaderEntry]) wins = rows();
  @type([LeaderEntry]) speed = rows();
  @type([LeaderEntry]) rebirths = rows();
}

const rows = (): ArraySchema<LeaderEntry> => {
  const list = new ArraySchema<LeaderEntry>();
  for (let i = 0; i < LEADERBOARD_SIZE; i += 1) list.push(new LeaderEntry());
  return list;
};

/**
 * The guardian of stage 5.
 *
 * The one hazard that is replicated rather than derived, because it CHASES -
 * its position depends on where the players are, which is state and not a
 * formula. The server owns every field here; the client draws them and does
 * nothing else with them.
 */
export class GuardianState extends Schema {
  @type('float32') x = 0;
  @type('float32') z = 0;
  @type('float32') rotationY = 0;
  /** True while it has noticed someone. Drives the run cycle and the trumpet. */
  @type('boolean') charging = false;
}

/** Root replicated state for a single world instance. */
export class CourseState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();

  /**
   * Server uptime in seconds.
   *
   * Not a diagnostic: it is the CLOCK that the rolling balls, the sweepers and
   * the sinking platforms are pure functions of. The server evaluates them
   * against this to decide a death, and the client evaluates the identical
   * functions against the replicated value to draw them - so there is no
   * hazard state on the wire at all.
   */
  @type('float64') elapsed = 0;

  @type(GuardianState) guardian = new GuardianState();

  @type(LeaderboardState) leaderboard = new LeaderboardState();
}
