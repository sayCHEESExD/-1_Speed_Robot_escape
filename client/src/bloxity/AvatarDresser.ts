import {
  DEFAULT_APPEARANCE,
  DEFAULT_PROPORTIONS,
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

  /**
   * The body currently built, as a key.
   *
   * Empty ONLY before the first look arrives - the state a mount is born in,
   * wearing the bundled rider. Every look after that has a key, the default
   * avatar's included, so arriving at the default still triggers a build.
   */
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

    /*
     * THE BLOXITY BODY IS BUILT EVEN WHEN NOTHING IS EQUIPPED.
     *
     * This used to ask `isDefaultAppearance` first and, for a player wearing
     * no items, skip the build entirely and keep the bundled `player.fbx`.
     * That is not what "default avatar" means on the portal: Bloxity's default
     * IS a real avatar - their `player.glb` body wearing `skins/0.png` - and a
     * player who picks it was being shown this project's own model and texture
     * instead of the one they chose. `applySkin` was already correct and could
     * never run, because it only reaches for the portal's default skin when it
     * is on a Bloxity body, and it never was.
     *
     * `build` handles an empty appearance on its own: it clones the base body
     * and swaps no parts, which is exactly the default avatar. So the decision
     * is no longer "did they equip anything" but "can the portal body be had at
     * all" - and that is answered by the build returning null, below.
     */
    const key = bodyKeyOf(appearance);
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      void this.rebuildBody(appearance);
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

  private async rebuildBody(appearance: AvatarAppearance): Promise<void> {
    const token = (this.bodyToken += 1);

    /*
     * Null is now the ONE genuine fallback: the portal body could not be had.
     *
     * No SDK, a blocked CDN, a failed fetch - those are the cases that leave a
     * player with the bundled rider and the texture it ships with, because
     * there is nothing else to draw them as. "Wearing no items" is NOT one of
     * them any more; that is a Bloxity avatar like any other.
     */
    const model = await bloxityRiderFactory.build(appearance);
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
