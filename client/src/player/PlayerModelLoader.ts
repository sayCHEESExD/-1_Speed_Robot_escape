import { FBX_TO_WORLD_SCALE } from '@robot/shared';
import {
  Box3,
  Color,
  LinearFilter,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  type AnimationClip,
  type BufferGeometry,
} from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  ASSET_PATHS,
  EXPECTED_BONE_NAMES,
  PLAYER_TEXTURE_SETTINGS,
  TEXTURE_REMAP,
} from '../config/assets.js';
import { logger } from '../util/logger.js';

const SCOPE = 'PlayerModelLoader';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|tga|bmp|gif|webp)$/i;

/** What the loader actually found inside the FBX, verified at runtime. */
export interface PlayerModelReport {
  /** Unique bone names, in skeleton order. */
  boneNames: string[];
  /** Skinned/static mesh names found in the file. */
  meshNames: string[];
  /** Animation clips embedded in the FBX (this file has none). */
  animationClipNames: string[];
  /** Bones from EXPECTED_BONE_NAMES that are missing. */
  missingBones: string[];
  /** Bones present in the file but not in EXPECTED_BONE_NAMES. */
  unexpectedBones: string[];
  /** Total vertices across all meshes. */
  vertexCount: number;
  /** Model height in world units after FBX_TO_WORLD_SCALE is applied. */
  heightWorldUnits: number;
  /** Texture URLs the FBX asked for, and what they were remapped to. */
  textureRemaps: Array<{ requested: string; served: string }>;
}

/**
 * Loads player.fbx once and hands out cloned, correctly-materialled instances.
 *
 * Texture strategy (the FBX's absolute paths are dead - see config/assets.ts):
 *   1. A LoadingManager URL modifier intercepts every texture request the FBX
 *      makes and redirects it to a real asset, so no 404 ever hits the network.
 *   2. After parsing, every material is REPLACED with one we build ourselves.
 *      Step 2 alone would be enough to render correctly; step 1 keeps the
 *      console and network tab clean and makes the strategy explicit.
 */
export class PlayerModelLoader {
  private prototype: Object3D | null = null;
  private texture: Texture | null = null;
  private material: MeshStandardMaterial | null = null;
  private report: PlayerModelReport | null = null;
  private loadPromise: Promise<PlayerModelReport> | null = null;

  private readonly remapLog: Array<{ requested: string; served: string }> = [];

  /** Idempotent. Concurrent callers share one network load. */
  load(): Promise<PlayerModelReport> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  /** Diagnostics from the last load, or null before load() resolves. */
  getReport(): PlayerModelReport | null {
    return this.report;
  }

  /**
   * A fresh, independently-animatable copy of the player model.
   * Bones are deep-cloned so each character owns its own skeleton.
   *
   * Every instance shares the ONE default material - local and remote alike.
   * There is deliberately no per-instance colour: a player is the model as
   * authored, and a per-session tint is a second appearance to keep in step
   * with the first for no gameplay benefit.
   */
  createInstance(): Object3D {
    if (!this.prototype) {
      throw new Error('PlayerModelLoader.createInstance() called before load() resolved');
    }

    return cloneSkeleton(this.prototype);
  }

  private async doLoad(): Promise<PlayerModelReport> {
    const manager = new LoadingManager();
    manager.setURLModifier((url) => this.resolveUrl(url));

    this.texture = await this.loadTexture(manager);
    this.material = this.buildMaterial();

    const fbx = await new Promise<Object3D & { animations: AnimationClip[] }>(
      (resolve, reject) => {
        new FBXLoader(manager).load(
          ASSET_PATHS.playerModel,
          (object) => resolve(object as Object3D & { animations: AnimationClip[] }),
          undefined,
          (error) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      },
    );

    fbx.scale.setScalar(FBX_TO_WORLD_SCALE);
    fbx.updateMatrixWorld(true);

    this.applyMaterials(fbx);
    this.report = this.buildReport(fbx);
    this.prototype = fbx;

    this.logReport(this.report);
    return this.report;
  }

  /** Redirect any FBX-declared texture to an asset that actually exists. */
  private resolveUrl(url: string): string {
    if (url === ASSET_PATHS.playerModel) return url;
    if (url === ASSET_PATHS.playerTexture) return url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;

    const basename = url.split(/[\\/]/).pop() ?? url;
    const mapped = TEXTURE_REMAP[basename];

    if (mapped !== undefined) {
      this.remapLog.push({ requested: url, served: mapped });
      return mapped;
    }

    if (IMAGE_EXTENSIONS.test(basename)) {
      // Unknown texture reference - serve the player atlas rather than 404.
      this.remapLog.push({ requested: url, served: ASSET_PATHS.playerTexture });
      return ASSET_PATHS.playerTexture;
    }

    return url;
  }

  private loadTexture(manager: LoadingManager): Promise<Texture> {
    return new Promise((resolve, reject) => {
      new TextureLoader(manager).load(
        ASSET_PATHS.playerTexture,
        (texture) => {
          texture.colorSpace = SRGBColorSpace;
          texture.flipY = PLAYER_TEXTURE_SETTINGS.flipY;
          texture.generateMipmaps = PLAYER_TEXTURE_SETTINGS.generateMipmaps;
          if (PLAYER_TEXTURE_SETTINGS.nearestFilter) {
            texture.magFilter = NearestFilter;
            texture.minFilter = NearestFilter;
          } else {
            texture.minFilter = LinearFilter;
          }
          texture.needsUpdate = true;
          resolve(texture);
        },
        undefined,
        (error) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  /**
   * The player material. ONE instance, opaque, untinted.
   *
   * Every player renders identically: "ghosted" means players do not collide,
   * and nothing more. Neither transparency nor a per-session colour survives
   * here - both were a second appearance to keep in step with the first, for
   * no gameplay benefit.
   */
  private buildMaterial(): MeshStandardMaterial {
    return new MeshStandardMaterial({
      map: this.texture,
      color: new Color(0xffffff),
      roughness: 0.85,
      metalness: 0.0,
    });
  }

  /**
   * Discard whatever materials FBXLoader produced from the dead texture paths
   * and assign ours. This is what guarantees a correct render.
   */
  private applyMaterials(root: Object3D): void {
    const material = this.material;
    if (!material) return;

    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;

      const previous = child.material;
      if (Array.isArray(previous)) previous.forEach((m) => m.dispose());
      else previous?.dispose();

      child.material = material;
      child.castShadow = true;
      child.receiveShadow = true;
      // Skinned FBX bounds are unreliable; culling them causes vanishing limbs.
      child.frustumCulled = false;
    });
  }

  private buildReport(root: Object3D): PlayerModelReport {
    const boneNames: string[] = [];
    const seenBones = new Set<string>();
    const meshNames: string[] = [];
    let vertexCount = 0;

    root.traverse((child) => {
      if (child instanceof SkinnedMesh) {
        meshNames.push(child.name || '(unnamed skinned mesh)');
        vertexCount += countVertices(child.geometry);
        for (const bone of child.skeleton.bones) {
          if (seenBones.has(bone.name)) continue;
          seenBones.add(bone.name);
          boneNames.push(bone.name);
        }
      } else if (child instanceof Mesh) {
        meshNames.push(child.name || '(unnamed mesh)');
        vertexCount += countVertices(child.geometry);
      }
    });

    const expected = new Set(EXPECTED_BONE_NAMES);
    const size = new Box3().setFromObject(root).getSize(new Vector3());

    const animations = (root as Object3D & { animations?: AnimationClip[] }).animations ?? [];

    return {
      boneNames,
      meshNames,
      animationClipNames: animations.map((clip) => clip.name),
      missingBones: EXPECTED_BONE_NAMES.filter((name) => !seenBones.has(name)),
      unexpectedBones: boneNames.filter((name) => !expected.has(name)),
      vertexCount,
      heightWorldUnits: size.y,
      textureRemaps: [...this.remapLog],
    };
  }

  private logReport(report: PlayerModelReport): void {
    logger.info(
      SCOPE,
      `loaded ${ASSET_PATHS.playerModel}: ${report.meshNames.length} mesh(es), ` +
        `${report.vertexCount} verts, ${report.boneNames.length} bones, ` +
        `height ${report.heightWorldUnits.toFixed(2)} world units`,
    );
    logger.info(SCOPE, 'bones:', report.boneNames.join(', '));
    logger.info(SCOPE, 'meshes:', report.meshNames.join(', '));

    for (const remap of report.textureRemaps) {
      logger.info(SCOPE, `texture remap: ${remap.requested} -> ${remap.served}`);
    }

    if (report.animationClipNames.length === 0) {
      logger.info(
        SCOPE,
        'FBX contains no animation clips (expected) - the character is animated ' +
          'procedurally from its bones by PlayerAnimator.',
      );
    }

    if (report.missingBones.length > 0) {
      logger.warn(SCOPE, 'expected bones missing from rig:', report.missingBones.join(', '));
    }
    if (report.unexpectedBones.length > 0) {
      logger.warn(SCOPE, 'unexpected bones in rig:', report.unexpectedBones.join(', '));
    }
    if (report.missingBones.length === 0 && report.unexpectedBones.length === 0) {
      logger.info(SCOPE, 'skeleton matches EXPECTED_BONE_NAMES exactly');
    }
  }
}

const countVertices = (geometry: BufferGeometry): number =>
  geometry.getAttribute('position')?.count ?? 0;

/** Process-wide singleton - the model is loaded once and cloned per player. */
export const playerModelLoader = new PlayerModelLoader();
