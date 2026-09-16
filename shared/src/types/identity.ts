/**
 * THE PLAYER'S VISIBLE NAME, and the rules for trusting one.
 *
 * A player is identified INTERNALLY by an id their browser generated or by
 * their Bloxity account id, and neither of those is ever shown. What a player
 * sees over a mech and on a board is this: the display name the portal holds
 * for them, which they chose and which everybody else sees too.
 *
 * It arrives from a CLIENT, so nothing here is trusted beyond being drawn: the
 * name is trimmed and bounded, and the portrait must be on Bloxity's own CDN.
 * A forged name is a cosmetic lie and buys nothing - rewards, positions and
 * every figure on a board come from state the server owns.
 */

/** Longest display name a board row or a nameplate will carry. */
export const MAX_DISPLAY_NAME = 24;

/**
 * Where a portrait may come from.
 *
 * PINNED to the portal's own static host, the same rule the avatar assets
 * follow. An arbitrary URL here would be a client telling every other client
 * to fetch something of its choosing - a tracking pixel at best - and the
 * board draws these into a canvas that becomes a WebGL texture.
 */
export const PORTRAIT_ORIGIN = 'https://static.bloxity.io/';

/**
 * Control characters, which a name may not contain.
 *
 * Built from char codes rather than written as an escape class, so the pattern
 * survives every tool that has ever "helpfully" normalised a source file - and
 * so it is obvious what it covers: everything below space, plus DEL.
 */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** A player's visible identity, as replicated. */
export interface PlayerIdentity {
  /** The portal's display name. Empty when the player is not signed in. */
  readonly displayName: string;
  /** Portrait URL on the portal's CDN, or empty. */
  readonly avatarUrl: string;
}

/**
 * Clean a claimed identity into one that is safe to replicate.
 *
 * Whitespace is collapsed rather than merely trimmed: a name of forty spaces
 * with one letter in the middle is not a name, and a row is one line tall.
 * Control characters go for the same reason - a newline in a name would push
 * every board row out of its slot.
 */
export const sanitizeIdentity = (raw: unknown): PlayerIdentity => {
  const source = (raw ?? {}) as Partial<Record<keyof PlayerIdentity, unknown>>;

  const name = typeof source.displayName === 'string' ? source.displayName : '';
  const displayName = name
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME);

  const url = typeof source.avatarUrl === 'string' ? source.avatarUrl.trim() : '';
  const avatarUrl = url.startsWith(PORTRAIT_ORIGIN) ? url.slice(0, 300) : '';

  return { displayName, avatarUrl };
};

/**
 * What to call a player who has no display name.
 *
 * A signed-out player has no name to show, and the alternatives are all worse:
 * a blank row reads as a broken board, and the DERIVED handle is an identifier
 * - it carries a tag off their id, which is exactly the thing that must never
 * be presented to anyone as a name.
 *
 * So they are a guest. Anonymous players are indistinguishable from each other
 * on a board, which is the honest answer: nobody told the game who they are.
 */
export const GUEST_NAME = 'Guest';

/**
 * THE ONE PLACE that decides what a player is called on screen.
 *
 * Every nameplate, every board row and every list goes through here, so the
 * same player is the same name everywhere - and so the rule "an internal id is
 * never a name" is enforced in one function rather than remembered in twelve.
 */
export const visibleName = (displayName: string | undefined | null): string => {
  const name = (displayName ?? '').trim();
  return name.length > 0 ? name : GUEST_NAME;
};
