/**
 * The rig in assets/player/player.fbx, verified at runtime by
 * PlayerModelLoader against EXPECTED_BONE_NAMES.
 *
 * Order defines the index used by PoseBuffer, so do not reorder casually.
 */
export const BONE_NAMES = [
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
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Index of each bone within a PoseBuffer. */
export const BONE_INDEX: Readonly<Record<BoneName, number>> = Object.fromEntries(
  BONE_NAMES.map((name, index) => [name, index]),
) as Record<BoneName, number>;

export const BONE_COUNT = BONE_NAMES.length;
