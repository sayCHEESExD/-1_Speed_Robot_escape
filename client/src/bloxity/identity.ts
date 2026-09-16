import type { SetIdentityMessage } from '@robot/shared';
import type { LegionUser } from './legionTypes.js';

/**
 * WHAT A PLAYER IS CALLED, in one place.
 *
 * The portal holds three strings for a user and only one of them is a name:
 *
 *  - `displayName` is what they chose to be called. THIS is the name.
 *  - `username` is their login handle. It is an identifier, it is unique, and
 *    it is not what anybody wants to be called in a game.
 *  - `_id` is the account id. It never leaves this machine except as the join
 *    option the server keys progression on, and it is never drawn.
 *
 * A signed-out player has none of them, and gets an EMPTY name rather than an
 * invented one: the server owns the fallback, so that a player who is
 * signed out is called the same thing on every board, in every session and on
 * every other player's screen.
 */
export const identityFromLegion = (user: LegionUser | null): SetIdentityMessage => {
  const displayName = user?.displayName?.trim() || '';
  return {
    displayName,
    // The portrait, and only from the portal's own CDN - `sanitizeIdentity` on
    // the server drops anything else, and this is the value it is checking.
    avatarUrl: user?.pfp?.trim() || '',
  };
};
