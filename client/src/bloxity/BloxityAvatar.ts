import {
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  TextureLoader,
  type Bone,
  type Object3D,
  type Texture,
} from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { logger } from '../util/logger.js';
import { DEFAULT_SKIN_URL, assetUrl, describeItem } from './bloxityAssets.js';
import {
  isEquippedId,
  type LegionEquipped,
  type LegionProportions,
} from './legionTypes.js';
import { NearestFilter } from 'three';
import { riderNeckScale } from '@robot/shared';

const SCOPE = 'bloxity/avatar';

/**
 * Bloxity cosmetics, applied to the LOCAL rider.
 *
 * Three things are applied, and the choice of which three is deliberate:
 *
 *  - the SKIN, as a texture swap on the rider's own material;
 *  - the HAT and the BACK item, as meshes parented to real bones;
 *  - the PROPORTIONS, as scales and offsets on those same bones.
 *
 * The body PARTS are not applied here: those replace geometry on the body
 * itself and so belong to whatever built it - see `BloxityRiderFactory`. This
 * class dresses whichever rider is currently mounted, Bloxity body or bundled
 * `player.fbx`, which is why `rebind` exists.
 *
 * Every asset path comes from Bloxity's item catalogue rather than from a
 * pattern spelled out here. An id is looked up, its `assetPaths` are used
 * verbatim, and an item the catalogue does not know is simply not worn.
 */
export class BloxityAvatar {
  private riderVisual: Group;
  private bones: ReadonlyMap<string, Bone>;
  /** True while the rider is a Bloxity body rather than the bundled one. */
  private wearingBloxityBody = false;

  /** The rider's own material, cloned so remote players keep the default. */
  private material: MeshStandardMaterial | null = null;
  /** The texture the model shipped with, to go back to when a skin is removed. */
  private defaultMap: Texture | null = null;

  private readonly attachments = new Map<'hat' | 'back', Object3D>();
  private readonly loadedTextures: Texture[] = [];

  /** What is currently worn, so an unchanged patch does no work. */
  /*
   * What is currently WORN in each slot.
   *
   * THREE states, not two, and the third is the whole reason this is not a
   * plain `string | null`: `undefined` means "nothing has been applied to this
   * body yet", `null` means "applied, and the answer was none".
   *
   * Collapsing those two is a real bug and it shipped. A rebind used to set
   * these to `null` to mean "re-wear everything", but for a player with no
   * skin equipped the WANTED value is also `null` - so the comparison in
   * `applySkin` matched, the load was skipped, and a freshly built Bloxity
   * body was left with no texture at all, which renders white.
   */
  private currentSkin: string | null | undefined = undefined;
  private currentHat: string | null | undefined = undefined;
  private currentBack: string | null | undefined = undefined;

  private readonly objLoader = new OBJLoader();
  private readonly textureLoader = new TextureLoader();

  private disposed = false;

  constructor(riderVisual: Group, riderModel: Object3D) {
    this.riderVisual = riderVisual;
    this.bones = collectBones(riderModel);
    this.material = this.cloneRiderMaterial(riderModel);
    this.defaultMap = this.material?.map ?? null;
  }

  /**
   * Wear what the account has equipped.
   *
   * Safe to call on every avatar event: each slot is compared against what is
   * already worn, so the common case - a proportions change - touches no
   * network at all.
   */
  apply(equipped: LegionEquipped, proportions: LegionProportions): void {
    if (this.disposed) return;

    this.applySkin(equipped.skinId ?? null);
    void this.applyItem('hat', equipped.hatId ?? null);
    void this.applyItem('back', equipped.backId ?? null);
    this.applyProportions(proportions);

  }

  /**
   * Follow the rider onto a new body.
   *
   * Called when the mount swaps in a Bloxity avatar, or swaps back to the
   * bundled one. Everything this class holds is bound to a particular model -
   * the bones it hangs items on, the material it re-skins - so a swap has to
   * re-collect all of it and then re-wear what was already worn, which is what
   * clearing the three `current*` fields arranges: the next `apply` sees every
   * slot as changed and puts it back on the new body.
   */
  rebind(riderVisual: Group, riderModel: Object3D, bloxityBody: boolean): void {
    for (const [, node] of this.attachments) node.removeFromParent();
    this.attachments.clear();

    this.riderVisual = riderVisual;
    this.bones = collectBones(riderModel);
    this.material = this.cloneRiderMaterial(riderModel);
    this.defaultMap = this.material?.map ?? null;
    this.wearingBloxityBody = bloxityBody;

    // UNDEFINED, not null: "not applied to this body yet". See the fields.
    this.currentSkin = undefined;
    this.currentHat = undefined;
    this.currentBack = undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const [, node] of this.attachments) node.removeFromParent();
    this.attachments.clear();
    for (const texture of this.loadedTextures) texture.dispose();
    this.loadedTextures.length = 0;
    this.material?.dispose();
    this.material = null;
  }

  // ------------------------------------------------------------------ skin

  private applySkin(id: string | null): void {
    const wanted = isEquippedId(id) ? id : null;
    if (wanted === this.currentSkin) return;
    this.currentSkin = wanted;
    void this.loadSkin(wanted);
  }

  /**
   * Put a skin on the body.
   *
   * A Bloxity body with no skin equipped is not bare - it wears Bloxity's own
   * default, which is what their renderer falls back to. The bundled rider
   * instead goes back to the texture it shipped with, because a Bloxity skin
   * is authored for a different UV layout entirely.
   */
  private async loadSkin(wanted: string | null): Promise<void> {
    const material = this.material;
    if (!material) return;

    let url: string | null = null;
    if (wanted) {
      const item = await describeItem(wanted);
      const path = item?.assetPaths?.texture;
      if (path) url = assetUrl(path);
    } else if (this.wearingBloxityBody) {
      url = DEFAULT_SKIN_URL;
    }

    // Still wanted? The player may have changed skin while this was in flight.
    if (this.disposed || this.currentSkin !== wanted) return;

    if (!url) {
      material.map = this.defaultMap;
      material.needsUpdate = true;
      return;
    }

    this.textureLoader.load(
      url,
      (texture) => {
        if (this.disposed || this.currentSkin !== wanted) {
          texture.dispose();
          return;
        }
        texture.colorSpace = SRGBColorSpace;
        texture.flipY = false;
        // Bloxity skins are 64x64 pixel art. Smoothing them turns a face into
        // a smudge, which is why their own renderer filters them this way too.
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        this.loadedTextures.push(texture);
        material.map = texture;
        material.needsUpdate = true;
      },
      undefined,
      () => logger.warn(SCOPE, `skin ${wanted ?? 'default'} failed to load`),
    );
  }

  // ------------------------------------------------------------------ items

  /**
   * Parent a hat or a back item to a real bone.
   *
   * To a BONE, not to the rider group: an item hung off the group would keep
   * its own idea of where the head is while the head moved, which is the same
   * class of mistake as copying a transform a frame late.
   */
  private async applyItem(slot: 'hat' | 'back', id: string | null): Promise<void> {
    const wanted = isEquippedId(id) ? id : null;
    const current = slot === 'hat' ? this.currentHat : this.currentBack;
    if (wanted === current) return;
    if (slot === 'hat') this.currentHat = wanted;
    else this.currentBack = wanted;

    const existing = this.attachments.get(slot);
    if (existing) {
      existing.removeFromParent();
      this.attachments.delete(slot);
    }
    if (!wanted) return;

    const anchor = this.bones.get(slot === 'hat' ? 'Neck1' : 'Spine2');
    if (!anchor) {
      logger.warn(SCOPE, `no bone to hang a ${slot} on`);
      return;
    }

    // The catalogue knows where the item lives; nothing here guesses.
    const item = await describeItem(wanted);
    const meshPath = item?.assetPaths?.mesh;
    const texturePath = item?.assetPaths?.texture;
    if (!meshPath || !texturePath) {
      logger.warn(SCOPE, `${slot} ${wanted} has no mesh in the catalogue`);
      return;
    }

    try {
      const object = await this.objLoader.loadAsync(assetUrl(meshPath));
      if (this.disposed) return;
      // Still wanted? The player may have changed it while this was in flight.
      const stillWanted = slot === 'hat' ? this.currentHat : this.currentBack;
      if (stillWanted !== wanted) return;

      const texture = await this.textureLoader.loadAsync(assetUrl(texturePath));
      texture.colorSpace = SRGBColorSpace;
      texture.flipY = false;
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.loadedTextures.push(texture);

      const material = new MeshStandardMaterial({ map: texture, roughness: 0.85 });
      object.traverse((child) => {
        if (child instanceof Mesh) {
          child.material = material;
          child.castShadow = true;
        }
      });

      // An item is sized against the BONE it hangs on, and the two bodies do
      // not share a bone space: `player.fbx` is authored in centimetres and
      // scaled down on load, while the Bloxity body is the rig these items
      // were made for. So a Bloxity body gets Bloxity's own numbers - scale 1,
      // a hat lifted 0.8 up the head bone, a back item sitting on the spine -
      // and the bundled body keeps the values tuned for it.
      const native = this.wearingBloxityBody;
      object.scale.setScalar(native ? 1 : ITEM_SCALE);
      if (slot === 'hat') object.position.set(0, native ? BLOXITY_HAT_LIFT : HAT_LIFT, 0);
      else object.position.set(0, 0, native ? 0 : BACK_OFFSET);

      anchor.add(object);
      this.attachments.set(slot, object);
      logger.info(SCOPE, `wearing ${slot} ${wanted}`);
    } catch {
      logger.warn(SCOPE, `${slot} ${wanted} failed to load`);
    }
  }

  // ----------------------------------------------------------- proportions

  /**
   * Apply the account's proportions.
   *
   * Scale and POSITION only - never rotation. `PlayerRig` rebuilds every
   * bone's quaternion from its rest pose on every single frame, so a rotation
   * written here would be gone before it was drawn; scale and position are
   * untouched by it and therefore survive.
   */
  private applyProportions(p: LegionProportions): void {
    const num = (value: number, fallback = 1): number =>
      Number.isFinite(value) && value > 0 ? value : fallback;

    // Height scales the whole rider. The robot's seat is a fixed point, so
    // this grows the rider upward from where they sit rather than through the
    // robot's back.
    this.riderVisual.scale.setScalar(num(p.height));

    const spine1 = this.bones.get('Spine1');
    if (spine1) spine1.scale.x = num(p.torsoScaleX);

    const spine2 = this.bones.get('Spine2');
    if (spine2) spine2.scale.x = num(p.shoulderWidth);

    /*
     * The portal's head proportion, TIMES this game's own.
     *
     * Not `setScalar(num(p.headScale))`. That ran after the rig was bound and
     * overwrote the enlargement the pilot needs to be recognisable from the
     * chase camera, putting almost every player back on a head scale of
     * exactly 1. `riderNeckScale` multiplies the two, so a player's own choice
     * still does what they chose.
     */
    const neck = this.bones.get('Neck1');
    if (neck) neck.scale.setScalar(riderNeckScale(num(p.headScale)));

    for (const name of ['ArmL1', 'ArmR1'] as const) {
      const bone = this.bones.get(name);
      if (bone) bone.scale.y = num(p.armLength);
    }

    // `legOffsetX` is a straddle, so it moves the legs apart rather than
    // scaling them: the rider is sitting on a barrel, and that is the one
    // proportion this game's pose actually cares about.
    const straddle = Number.isFinite(p.legOffsetX) ? p.legOffsetX : 1;
    for (const [name, side] of [['LegL1', 1], ['LegR1', -1]] as const) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      bone.position.x = bone.userData['restX'] as number ?? bone.position.x;
      if (bone.userData['restX'] === undefined) bone.userData['restX'] = bone.position.x;
      bone.position.x = (bone.userData['restX'] as number) + side * (straddle - 1) * LEG_SPREAD;
    }
  }

  /**
   * Give the local rider its own material.
   *
   * Every instance shares ONE material by design, which is exactly right until
   * one of them needs a different skin - at which point writing to it would
   * re-skin every remote player too.
   */
  private cloneRiderMaterial(model: Object3D): MeshStandardMaterial | null {
    let cloned: MeshStandardMaterial | null = null;
    model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const material = child.material;
      if (!(material instanceof MeshStandardMaterial)) return;
      cloned ??= material.clone();
      child.material = cloned;
    });
    return cloned;
  }
}

/** How big a CDN item is, in the bone space it hangs in. */
const ITEM_SCALE = 0.9;
/** A hat sits above the head bone's origin, on the bundled body. */
const HAT_LIFT = 0.55;
/**
 * The same lift on a Bloxity body.
 *
 * Bloxity's own figure, not a tuned one: their renderer parents a hat to the
 * head bone at `(0, 0.8, 0)`. These items are authored for that rig, so the
 * number that makes them sit right is theirs.
 */
const BLOXITY_HAT_LIFT = 0.8;
/** A back item sits behind the chest. */
const BACK_OFFSET = -0.35;
/** World units the legs move apart per unit of `legOffsetX`. */
const LEG_SPREAD = 0.12;

/** The rig's bones, by name. Same first-bone rule `PlayerRig` uses. */
const collectBones = (model: Object3D): Map<string, Bone> => {
  const found = new Map<string, Bone>();
  model.traverse((child) => {
    const bone = child as Bone;
    if (bone.isBone && !found.has(bone.name)) found.set(bone.name, bone);
  });
  return found;
};
