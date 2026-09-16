/**
 * Asset paths and the explicit texture strategy for the supplied FBX.
 *
 * The shipped player.fbx embeds DEAD absolute texture paths from the original
 * author's machine:
 *   X:\legion\poxel\character\assets\textures\test.png   (diffuse)
 *   X:\legion\poxel\character\small_bevel.png            (normal map)
 *
 * Those files do not exist here, so we never let the loader chase them. Every
 * texture request the FBX makes is remapped through TEXTURE_REMAP before a
 * network request happens, and the final materials are assigned explicitly
 * after load. See player/PlayerModelLoader.ts.
 */

/** Served from the repo-level `assets/` folder (Vite publicDir). */
export const ASSET_PATHS = {
  playerModel: '/player/player.fbx',
  playerTexture: '/player/green.png',
} as const;

/**
 * A 1x1 flat normal map (RGB 128,128,255) as a data URI, used to satisfy the
 * FBX's missing `small_bevel.png` without a network request.
 */
export const FLAT_NORMAL_DATA_URI =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Basename -> replacement URL. Any texture the FBX asks for that is not listed
 * here falls back to the player texture, so a 404 can never reach the network.
 */
export const TEXTURE_REMAP: Readonly<Record<string, string>> = {
  'test.png': ASSET_PATHS.playerTexture,
  'small_bevel.png': FLAT_NORMAL_DATA_URI,
};

/**
 * green.png is a 64x64 pixel-art atlas, not a smooth texture. Nearest-neighbour
 * filtering and no mipmap blur keep the blocky look the model was authored for.
 */
export const PLAYER_TEXTURE_SETTINGS = {
  nearestFilter: true,
  generateMipmaps: false,
  /** FBX UVs assume three.js' default flipped-Y texture orientation. */
  flipY: true,
} as const;

/**
 * Bone names expected in player.fbx, verified at runtime after load.
 * Source of truth is the FBX itself - this list exists so a silent rig change
 * produces a loud warning instead of broken animation later.
 */
export const EXPECTED_BONE_NAMES: readonly string[] = [
  'Rig1',
  'Spine1',
  'Spine2',
  'Neck1',
  'ArmL1',
  'ArmL2',
  'ArmR1',
  'ArmR2',
  'LegL1',
  'LegL2',
  'LegR1',
  'LegR2',
];
