import { PLAYER_HEIGHT, type AvatarAppearance } from '@robot/shared';
import {
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
  type BufferAttribute,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { logger } from '../util/logger.js';
import {
  BLOXITY_MODEL_HEIGHT,
  PART_TARGETS,
  PLAYER_GLB_URL,
  assetUrl,
  describeItem,
  type BloxityItem,
} from './bloxityAssets.js';

const SCOPE = 'bloxity/rider';

/**
 * Builds a rider out of a player's Bloxity avatar.
 *
 * The body is Bloxity's `player.glb`, and the body PARTS are geometry swapped
 * onto its skeleton - which is how Bloxity's own renderer does it, and the only
 * way it can be done: a part is authored as a skinned mesh against that one
 * shared rig, so it has no meaning except as a replacement for the mesh it
 * stands in for.
 *
 * What makes this safe to drop into this game is that Bloxity's rig and
 * `player.fbx`'s rig are THE SAME RIG. The GLB carries the twelve bone names
 * `PlayerRig` binds, so the whole procedural animation system - gait phase,
 * posting bob, the straddle - drives a Bloxity body without knowing it is one.
 * Nothing here writes a bone rotation, and nothing here animates.
 *
 * Everything is cached by URL, so ten players in the same hat cost one hat.
 */
export class BloxityRiderFactory {
  private prototype: Promise<Object3D | null> | null = null;

  /**
   * Remapped part geometry, by asset URL.
   *
   * Shareable between riders because the remap targets the PROTOTYPE's bone
   * order, and every rider is a clone of that one prototype - so the indices
   * this produces are correct for all of them.
   */
  private readonly parts = new Map<string, Promise<BufferGeometry | null>>();

  /** The base body, loaded once and cloned per rider. */
  private loadPrototype(): Promise<Object3D | null> {
    this.prototype ??= new GLTFLoader()
      .loadAsync(PLAYER_GLB_URL)
      .then((gltf) => {
        const root = gltf.scene;
        // Sized to this game's rider rather than to Bloxity's viewer: the GLB
        // stands 6.4 units tall and a rider here is 3.2.
        root.scale.setScalar(PLAYER_HEIGHT / BLOXITY_MODEL_HEIGHT);
        root.updateMatrixWorld(true);
        return root;
      })
      .catch((error: unknown) => {
        logger.warn(SCOPE, `base avatar failed to load: ${String(error)}`);
        return null;
      });
    return this.prototype;
  }

  /**
   * Build a rider wearing `appearance`, or null if the body cannot be had.
   *
   * Null is not an error path so much as the fallback path: the caller keeps
   * the bundled character, which is exactly what should happen when Bloxity is
   * blocked, offline, or having a bad day.
   */
  async build(appearance: AvatarAppearance): Promise<Object3D | null> {
    const prototype = await this.loadPrototype();
    if (!prototype) return null;

    const rider = cloneSkeleton(prototype);

    // One material for the whole body, as Bloxity's renderer uses: the skin is
    // a single texture atlas covering every part. The caller owns the map -
    // `BloxityAvatar` sets it - so this only has to make sure the material is
    // this rider's OWN rather than one shared with everybody else's.
    const skinned: SkinnedMesh[] = [];
    const material = new MeshStandardMaterial({ metalness: 0, roughness: 1 });
    rider.traverse((child) => {
      if (child instanceof SkinnedMesh) {
        child.material = material;
        child.castShadow = true;
        skinned.push(child);
      } else if (child instanceof Mesh) {
        child.material = material;
        child.castShadow = true;
      }
    });

    // Marks this rider as one whose material is its OWN, so `Mount` knows it
    // may dispose it on a swap rather than pulling it out from under every
    // default rider sharing the bundled one.
    rider.userData['bloxityRider'] = true;

    await this.wearParts(appearance, skinned);
    return rider;
  }

  /** Swap in every equipped body part, in parallel. */
  private async wearParts(
    appearance: AvatarAppearance,
    skinned: readonly SkinnedMesh[],
  ): Promise<void> {
    const wanted: Array<{ id: string; slot: NonNullable<BloxityItem['partSlot']> }> = [];
    if (appearance.headId) wanted.push({ id: appearance.headId, slot: 'head' });
    if (appearance.torsoId) wanted.push({ id: appearance.torsoId, slot: 'torso' });
    // Arms and legs are ONE catalogue item carrying two meshes, so a left and a
    // right that came from the same id resolve to the same lookup.
    if (appearance.armLId) wanted.push({ id: appearance.armLId, slot: 'arms' });
    if (appearance.legLId) wanted.push({ id: appearance.legLId, slot: 'legs' });

    await Promise.all(
      wanted.map(async ({ id, slot }) => {
        const item = await describeItem(id);
        if (!item?.assetPaths) return;

        await Promise.all(
          PART_TARGETS[slot].map(async (target) => {
            const path = item.assetPaths?.[target.path];
            if (!path) return;

            const mesh = skinned.find((candidate) => candidate.name === target.mesh);
            if (!mesh) return;

            const geometry = await this.loadPart(assetUrl(path), mesh);
            if (geometry) mesh.geometry = geometry;
          }),
        );
      }),
    );
  }

  /**
   * Load one part and retarget its skinning onto the base skeleton.
   *
   * A part GLB ships its own copy of the rig, so its `skinIndex` values are
   * indices into ITS joint list - which is ordered differently from the body's.
   * Assigning the geometry across untouched would attach a forearm to whatever
   * bone happened to occupy that slot in the other file. The fix is the one
   * Bloxity's renderer uses: translate every index through the BONE NAME, which
   * is the only thing the two files agree on.
   */
  private loadPart(url: string, target: SkinnedMesh): Promise<BufferGeometry | null> {
    const cached = this.parts.get(url);
    if (cached) return cached;

    const request = new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => {
        let source: SkinnedMesh | null = null;
        gltf.scene.traverse((child) => {
          if (!source && child instanceof SkinnedMesh) source = child;
        });
        if (!source) return null;
        return retarget(source, target);
      })
      .catch((error: unknown) => {
        logger.warn(SCOPE, `part ${url} failed to load: ${String(error)}`);
        return null;
      });

    this.parts.set(url, request);
    return request;
  }
}

/** Rewrite a part's bone indices to match the body it is being worn on. */
const retarget = (source: SkinnedMesh, target: SkinnedMesh): BufferGeometry | null => {
  const geometry = source.geometry.clone();
  const attribute = geometry.getAttribute('skinIndex') as BufferAttribute | undefined;
  if (!attribute) return geometry;

  const byName = new Map<string, number>();
  target.skeleton.bones.forEach((bone, index) => {
    if (!byName.has(bone.name)) byName.set(bone.name, index);
  });

  const translation = new Map<number, number>();
  source.skeleton.bones.forEach((bone, index) => {
    const mapped = byName.get(bone.name);
    if (mapped !== undefined) translation.set(index, mapped);
  });

  const array = attribute.array as unknown as { length: number; [index: number]: number };
  for (let i = 0; i < array.length; i += 1) {
    const mapped = translation.get(array[i] as number);
    if (mapped !== undefined) array[i] = mapped;
  }
  attribute.needsUpdate = true;
  return geometry;
};

/** One factory for the whole client, so its caches are shared by every rider. */
export const bloxityRiderFactory = new BloxityRiderFactory();
