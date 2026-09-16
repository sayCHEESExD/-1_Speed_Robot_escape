import type { SetIdentityMessage } from '@robot/shared';
import type { LegionUser } from './legionTypes.js';

/**
 * WHAT A PLAYER IS CALLED, in one place.
 *
 * The portal holds several strings for a visitor and only some of them are a
 * name:
 *
 *  - `displayName` is what they chose to be called. THIS is the name.
 *  - `username` is their portal handle. It is a real, chosen, human-readable
 *    name and the portal itself falls back to it - its own friend list and
 *    its own toasts read `displayName || username` - so this does too, rather
 *    than throwing away a perfectly good name and calling somebody "Guest".
 *  - `_id` is the account id. It never leaves this machine except as the join
 *    option the server keys progression on, and it is NEVER drawn.
 *
 * THE PORTAL NAMES ITS GUESTS TOO, and forgetting that is what made a signed
 * out - and, more importantly, a merely not-yet-signed-in - player appear as
 * "Guest" over their own mech. `auth.getUser()` is null for a visitor who has
 * not logged in, and `auth.getGuest()` answers for them instead: a real name
 * like "Chicken 877" and a real rendered portrait. Exactly one of the two is
 * ever non-null, so taking the first that answers is the whole rule.
 *
 * Only when the portal is absent entirely - no SDK, a blocked CDN, the game
 * served from somewhere else - is there no name at all. That is the one case
 * the server's own `visibleName` fallback is for.
 */
export const identityFromLegion = (
  user: LegionUser | null,
  guest: LegionUser | null = null,
): SetIdentityMessage => {
  // Signed in wins; the guest identity is what the portal offers in its place.
  const who = user ?? guest;
  return {
    displayName: who?.displayName?.trim() || who?.username?.trim() || '',
    // The portrait, and only from the portal's own CDN - `sanitizeIdentity` on
    // the server drops anything else, and this is the value it is checking.
    avatarUrl: who?.pfp?.trim() || '',
  };
};

