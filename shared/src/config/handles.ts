/**
 * Display handles.
 *
 * This game has no accounts and asks for no names: a player is a uuid their own
 * browser generated. The scoreboard still has to call them something, so a
 * handle is DERIVED from that id - deterministically, so the same player is the
 * same name on every board, in every session, on every machine, with nothing
 * stored and nothing for a client to assert.
 *
 * Nothing here is secret and nothing here is unique: two ids can collide on a
 * handle. That is fine for a leaderboard and would not be for an identity,
 * which is precisely why the id itself never leaves the server.
 */

/** Adjective half. Deliberately short, so a full handle fits a board row. */
const FIRST = [
  'Swift', 'Bold', 'Wild', 'Lucky', 'Turbo', 'Iron', 'Neon', 'Storm',
  'Sunny', 'Rapid', 'Mega', 'Cosmic', 'Frost', 'Ember', 'Jade', 'Vivid',
] as const;

/**
 * Noun half, drawn from the game's own mechs and its verbs.
 *
 * SIXTEEN of them, exactly as many as `FIRST` - the tag that keeps two Swift
 * Walkers apart is four hex digits, and the pool size is what decides how
 * often it has to. Changing the length of either list changes nobody's handle:
 * they are indexed by a hash modulo the length, so a longer list would rename
 * every player on every board.
 */
const SECOND = [
  'Walker', 'Mech', 'Pilot', 'Frame', 'Comet', 'Bolt', 'Dash', 'Strider',
  'Titan', 'Trail', 'Sprint', 'Lancer', 'Racer', 'Charger', 'Core', 'Circuit',
] as const;

/**
 * A stable 32-bit hash of a string.
 *
 * FNV-1a: a handful of lines, no dependency, and stable across every engine -
 * which matters because a handle that hashed differently on two machines would
 * rename half the board on a server restart.
 */
const hash = (value: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * The handle a player id is shown as.
 *
 * Two words and a four-digit tag, e.g. `@SwiftWalker_2F91`. The tag is what
 * keeps two Swift Walkers apart on the same board.
 */
export const handleFor = (playerId: string): string => {
  if (!playerId) return '@Pilot_0000';
  const h = hash(playerId);
  const first = FIRST[h % FIRST.length] as string;
  const second = SECOND[(h >>> 8) % SECOND.length] as string;
  const tag = ((h >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `@${first}${second}_${tag}`;
};

/** How many places each board shows. Matches the reference art's nine rows. */
export const LEADERBOARD_SIZE = 9;
