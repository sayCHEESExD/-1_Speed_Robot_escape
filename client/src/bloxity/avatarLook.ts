import {
  sanitizeAppearance,
  sanitizeProportions,
  type AvatarAppearance,
  type AvatarProportions,
  type SetAvatarMessage,
} from '@robot/shared';
import type { LegionEquipped, LegionProportions } from './legionTypes.js';

/**
 * Translate what the portal reports into what this game replicates.
 *
 * The SDK's equipped ids are loosely typed - optional, nullable, and with
 * several spellings of "nothing" - while the wire form is nine plain strings.
 * `sanitizeAppearance` already knows every way Bloxity says none, so the
 * conversion is a call to it rather than a second set of rules that could
 * disagree with the server's.
 */
export const lookFromLegion = (
  equipped: LegionEquipped,
  proportions: LegionProportions,
): SetAvatarMessage => ({
  appearance: sanitizeAppearance(equipped),
  proportions: sanitizeProportions(proportions),
});

/**
 * Read a look back off replicated state.
 *
 * The schema is flat - nine ids and seven numbers on one object - because a
 * Colyseus schema is not a nested pair of interfaces. This splits it back into
 * the two the renderer wants, and sanitises again: the values were cleaned on
 * the server, and cleaning them here as well costs nothing and means a client
 * cannot be broken by a room that skipped it.
 */
export const lookFromState = (
  avatar: (AvatarAppearance & AvatarProportions) | undefined,
): { appearance: AvatarAppearance; proportions: AvatarProportions } => ({
  appearance: sanitizeAppearance(avatar),
  proportions: sanitizeProportions(avatar),
});
