import {
  DEFAULT_APPEARANCE,
  DEFAULT_PROPORTIONS,
  isDefaultAppearance,
  type AvatarAppearance,
  type AvatarProportions,
} from '@robot/shared';
import type { Mount } from '../player/Mount.js';
import { BloxityAvatar } from './BloxityAvatar.js';
import { bloxityRiderFactory } from './BloxityRiderFactory.js';
import { describeItem, peekItem } from './bloxityAssets.js';

/**
 * Puts one player's Bloxity appearance onto one mount.
 *
 * The single place that decides WHICH body a rider has, and it is deliberately
 * shared by the local player and every remote one: a player who looks one way
 * on their own screen and another way on everybody else's is the bug this
 * whole feature exists to remove, and two code paths is how that happens.
 *
 * The split of work is what keeps a re-dress cheap:
 *
 *  - the BODY is rebuilt only when a body PART changes, because that is the
 *    only thing that changes its geometry;
 *  - the skin, the hat, the back item and the proportions are applied to
 *    whatever body is currently mounted, and cost no rebuild at all.
 *
 * So the common case - somebody changes hat mid-run - re-parents one mesh.
 */
export class AvatarDresser {
  private readonly mount: Mount;
  private avatar: BloxityAvatar;

  /** The look as ASKED for, before a hat has had its say. */
  private requested: AvatarAppearance = DEFAULT_APPEARANCE;
  private requestedProportions: AvatarProportions = DEFAULT_PROPORTIONS;

  /** The look actually worn, after `forceHead`. */
  private appearance: AvatarAppearance = DEFAULT_APPEARANCE;
  private proportions: AvatarProportions = DEFAULT_PROPORTIONS;

  /** The body currently built, as a key. Empty means the bundled default. */
  private bodyKey = '';
  /**
   * Guards against an out-of-order build.
   *
   * A body is fetched over the network, so two quick changes can resolve in
   * either order. The later request wins by token, not by arrival, which is
   * the same rule the skin and item loaders use.
   */
  private bodyToken = 0;

  private disposed = false;

  constructor(mount: Mount) {
    this.mount = mount;
    const rider = mount.rider;
    this.avatar = new BloxityAvatar(rider.visual, rider.model);
  }

  /**
   * Wear this look.
   *
   * Safe to call on every patch: an unchanged look does no work, and nothing
   * here blocks. The mount keeps whatever body it already has - the bundled
   * default on a first join - until a new one has finished loading, so a
   * player is always drawn as something rather than as nothing.
   */
  setLook(requested: AvatarAppearance, proportions: AvatarProportions): void {
    if (this.disposed) return;

    this.requested = requested;
    this.requestedProportions = proportions;

    const appearance = this.forceHead(requested);
    this.appearance = appearance;
    this.proportions = proportions;

    const wantsBloxityBody = !isDefaultAppearance(appearance);
    const key = wantsBloxityBody ? bodyKeyOf(appearance) : '';
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      void this.rebuildBody(wantsBloxityBody, appearance);
    }

    // The worn layer goes on regardless: it is valid on either body, and on a
    // rebuild it is applied again once the new one has arrived.
    this.avatar.apply(appearance, proportions);
  }

  dispose(): void {
    this.disposed = true;
    this.bodyToken += 1;
    this.avatar.dispose();
  }

  /**
   * Let a hat override the head, the way the portal does.
   *
   * Bloxity applies `forceHeadId` when a hat is EQUIPPED - it writes the value
   * straight into `headId` - so a look that came from the portal already obeys
   * it and this changes nothing. It is applied again here because a renderer
   * should not depend on that: the look can reach this game from a join
   * option, from replicated state, or from an account dressed before the hat
   * declared the constraint, and in each of those a stale head would be drawn
   * inside a helmet that was modelled around the stock one.
   *
   * An unknown hat is fetched and the look re-applied when it lands, rather
   * than awaited: a hat nobody has seen before must not stall the body of a
   * player who is already on screen.
   */
  private forceHead(appearance: AvatarAppearance): AvatarAppearance {
    const hatId = appearance.hatId;
    if (!hatId) return appearance;

    const hat = peekItem(hatId);
    if (hat === undefined) {
      // Not looked up yet. Fetch, then run the whole decision again.
      void describeItem(hatId).then(() => {
        if (this.disposed || this.requested.hatId !== hatId) return;
        this.setLook(this.requested, this.requestedProportions);
      });
      return appearance;
    }

    const forced = hat?.forceHeadId;
    if (forced === undefined || forced === null) return appearance;

    // `'-1'` is Bloxity's "none", and none means the DEFAULT head - their
    // renderer restores the stock geometry rather than hiding anything. This
    // game spells that as an empty id, which `BloxityRiderFactory` already
    // reads as "leave the default head alone".
    const headId = forced === '-1' || forced === '' ? '' : forced;
    if (headId === appearance.headId) return appearance;

    return { ...appearance, headId };
  }

  private async rebuildBody(
    wantsBloxityBody: boolean,
    appearance: AvatarAppearance,
  ): Promise<void> {
    const token = (this.bodyToken += 1);

    // Null covers three cases that all mean the same thing to the mount: the
    // player is wearing nothing Bloxity, the asset could not be fetched, or
    // the base body itself is unavailable. Each restores the bundled rider.
    const model = wantsBloxityBody ? await bloxityRiderFactory.build(appearance) : null;
    if (this.disposed || token !== this.bodyToken) return;

    this.mount.setRider(model);

    const rider = this.mount.rider;
    this.avatar.rebind(rider.visual, rider.model, model !== null);
    // Re-wear onto the body that just arrived. The skin and the accessories
    // were applied to the OLD one, and a rebind deliberately forgets them.
    this.avatar.apply(this.appearance, this.proportions);
  }
}

/**
 * What makes two looks the same BODY.
 *
 * Body parts only. A hat, a skin or a set of proportions changes how a rider
 * looks without changing the geometry underneath, so including them here would
 * refetch and rebuild an identical body every time somebody changed hat.
 */
const bodyKeyOf = (a: AvatarAppearance): string =>
  [a.headId, a.torsoId, a.armLId, a.armRId, a.legLId, a.legRId].join('|');
