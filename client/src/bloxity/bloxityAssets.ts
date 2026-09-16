import { logger } from '../util/logger.js';

const SCOPE = 'bloxity/assets';

/**
 * Where Bloxity's avatar assets live.
 *
 * NOT invented, and not guessed from a naming pattern: both hosts are read out
 * of the SDK this game already loads from `sdk.bloxity.io`. Its character
 * renderer resolves every asset through `` `https://static.bloxity.io${path}` ``
 * and fetches its catalogue from `https://api.bloxity.io`, and each route used
 * below was confirmed against the live service before it was written here.
 *
 * The important consequence: NOTHING in this file builds an asset URL out of an
 * id. The catalogue hands back an `assetPaths` object per item and those paths
 * are used verbatim - so an item Bloxity moves, renames, or stores somewhere
 * new keeps working without a change here.
 */
const STATIC_BASE = 'https://static.bloxity.io';
const API_BASE = 'https://api.bloxity.io';

/**
 * The base body.
 *
 * The one path that IS a constant, because it is not an item and has no
 * catalogue entry - the SDK loads it by this literal too. Its skeleton is the
 * reason this whole feature is possible: 22 joints whose names are the same
 * twelve this game's rig binds (`Rig1`, `Spine1`, `Spine2`, `Neck1`, `ArmL1/2`,
 * `ArmR1/2`, `LegL1/2`, `LegR1/2`) plus `_Offset` parents and `_leaf`
 * terminals. `PlayerRig` binds BY NAME and reads each rest pose off the model
 * it is handed, so it drives this skeleton with no changes at all.
 */
export const PLAYER_GLB_URL = `${STATIC_BASE}/avatars/player.glb`;

/**
 * The skin worn when a Bloxity player has none equipped.
 *
 * The SDK's own fallback: it maps a missing or `'-1'` skin id to `0` and loads
 * `/avatars/skins/0.png`. A Bloxity body with no texture at all renders white.
 */
export const DEFAULT_SKIN_URL = `${STATIC_BASE}/avatars/skins/0.png`;

/** Resolve a catalogue-supplied path against the asset host. */
export const assetUrl = (path: string): string =>
  path.startsWith('http') ? path : `${STATIC_BASE}${path}`;

/** The catalogue's own item shape, narrowed to what a renderer needs. */
export interface BloxityItem {
  readonly id: string;
  readonly type: 'skin' | 'hat' | 'back' | 'part';
  /** Present on `part` items only. */
  readonly partSlot?: 'head' | 'torso' | 'arms' | 'legs';
  /**
   * On a HAT: the head this hat insists on being worn with.
   *
   * Not a hiding flag, which is the natural but wrong reading of the name.
   * Bloxity's customiser applies it as `equipped.headId = item.forceHeadId`,
   * and its renderer treats a head of `'-1'` as "put the DEFAULT head back" -
   * so today, where every one of the three hats that declare it declares
   * `'-1'`, it means "this helmet is modelled around the stock head, so wear
   * that". A custom head would poke through it.
   */
  readonly forceHeadId?: string | null;
  readonly assetPaths?: {
    /** Single mesh: a hat, a back item, a head or a torso. */
    readonly mesh?: string;
    /** Paired meshes: arms and legs are authored as a left and a right. */
    readonly meshL?: string;
    readonly meshR?: string;
    readonly texture?: string;
    readonly icon?: string;
  };
}

/**
 * The item cache.
 *
 * Keyed by id and holding the PROMISE rather than the result, which is what
 * makes two riders wearing the same hat share one request instead of racing
 * to make two. A failed lookup is cached as `null` deliberately: an id the
 * catalogue does not know will not start knowing it because a second player
 * wore it, and retrying per rider per join is how a missing item becomes a
 * request storm.
 */
const items = new Map<string, Promise<BloxityItem | null>>();

/**
 * The same items once they have actually resolved.
 *
 * A synchronous window onto the cache, for the one caller that has to decide
 * something DURING a frame rather than a tick later: `AvatarDresser` needs to
 * know whether a hat forces a head before it picks a body, and awaiting there
 * would make a re-dress asynchronous for every player who is not wearing one.
 */
const resolved = new Map<string, BloxityItem | null>();

/**
 * What the catalogue already knows about an item, without waiting.
 *
 * `undefined` means "not asked yet", which is deliberately distinct from the
 * `null` that means "asked, and there is no such item" - the caller can only
 * schedule a second look for the first of those.
 */
export const peekItem = (id: string): BloxityItem | null | undefined =>
  id ? resolved.get(id) : null;

/**
 * Look one item up in Bloxity's public catalogue.
 *
 * `GET /v1/avatar/items/{id}` - the per-item route, so a player wearing three
 * things costs three small requests rather than a walk through a catalogue of
 * hundreds. No authentication: appearance is public data, which is the whole
 * reason a remote player's look can be resolved from an id at all.
 */
export const describeItem = (id: string): Promise<BloxityItem | null> => {
  if (!id) return Promise.resolve(null);

  const cached = items.get(id);
  if (cached) return cached;

  const request = fetch(`${API_BASE}/v1/avatar/items/${encodeURIComponent(id)}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const item = (await response.json()) as BloxityItem;
      resolved.set(id, item);
      return item;
    })
    .catch((error: unknown) => {
      logger.warn(SCOPE, `item ${id} could not be resolved: ${String(error)}`);
      resolved.set(id, null);
      return null;
    });

  items.set(id, request);
  return request;
};

/**
 * Which mesh in `player.glb` a part replaces, and which path supplies it.
 *
 * The mesh names are the SDK's: it keeps the same table to know what a part is
 * standing in for. Arms and legs are PAIRS - one id, two meshes, `meshL` and
 * `meshR` - which is why this maps to a list rather than to a single name.
 */
export const PART_TARGETS: Readonly<
  Record<
    NonNullable<BloxityItem['partSlot']>,
    ReadonlyArray<{ mesh: string; path: 'mesh' | 'meshL' | 'meshR' }>
  >
> = {
  head: [{ mesh: 'default_head', path: 'mesh' }],
  torso: [{ mesh: 'default_torso', path: 'mesh' }],
  arms: [
    { mesh: 'default_arm_L', path: 'meshL' },
    { mesh: 'default_arm_R', path: 'meshR' },
  ],
  legs: [
    { mesh: 'default_leg_L', path: 'meshL' },
    { mesh: 'default_leg_R', path: 'meshR' },
  ],
};

/**
 * How tall `player.glb` stands in its own units, and how tall a rider is here.
 *
 * The GLB's bind pose measures 6.4 units head to foot; this game's rider is
 * `PLAYER_HEIGHT` (3.2) world units, being `player.fbx` at
 * `FBX_TO_WORLD_SCALE`. Halving the Bloxity body is what makes the two
 * interchangeable - a rider that swapped appearance and doubled in size would
 * be wearing the mount rather than sitting on it.
 */
export const BLOXITY_MODEL_HEIGHT = 6.4;
