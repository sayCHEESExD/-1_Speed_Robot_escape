/**
 * A player's Bloxity appearance, as it crosses the wire.
 *
 * COSMETIC ONLY, and that is the whole reason this is allowed to come from a
 * client at all. Every other field on `PlayerState` is written by the server
 * from its own simulation, because every other field decides something. These
 * ids decide nothing: they choose which mesh and which texture a renderer
 * fetches from Bloxity's public catalogue, and a player who forged one would
 * succeed only in wearing a hat.
 *
 * What is deliberately NOT here: the account id, the username, the email, the
 * token - none of which any renderer needs, and all of which would be private
 * data broadcast to every player in the room. The ids below are already public
 * catalogue keys; they are the minimum that lets a remote client draw someone.
 */
export interface AvatarAppearance {
  /** Texture on the body. */
  skinId: string;
  /** Body-part meshes, swapped onto the shared skeleton. */
  headId: string;
  torsoId: string;
  armLId: string;
  armRId: string;
  legLId: string;
  legRId: string;
  /** Accessories, hung off a bone. */
  hatId: string;
  backId: string;
}

/**
 * Body proportions. Every value is a MULTIPLIER whose neutral is 1.
 *
 * Replicated alongside the ids because a proportion is as much a part of how
 * somebody looks as the parts they wear - a tall player who reads as
 * short-and-wide to everyone else is not "seeing their actual appearance".
 * They are floats rather than ids, so they are clamped rather than pattern
 * matched.
 */
export interface AvatarProportions {
  height: number;
  shoulderWidth: number;
  armLength: number;
  legOffsetX: number;
  torsoScaleX: number;
  neckHeight: number;
  headScale: number;
}

export interface AvatarLook {
  readonly appearance: AvatarAppearance;
  readonly proportions: AvatarProportions;
}

/** Nothing equipped: the bundled default character. */
export const DEFAULT_APPEARANCE: AvatarAppearance = {
  skinId: '',
  headId: '',
  torsoId: '',
  armLId: '',
  armRId: '',
  legLId: '',
  legRId: '',
  hatId: '',
  backId: '',
};

/** Neutral proportions. */
export const DEFAULT_PROPORTIONS: AvatarProportions = {
  height: 1,
  shoulderWidth: 1,
  armLength: 1,
  legOffsetX: 1,
  torsoScaleX: 1,
  neckHeight: 1,
  headScale: 1,
};

/** The slots, in one list, so nothing iterates a hand-written copy of them. */
export const AVATAR_SLOTS = [
  'skinId',
  'headId',
  'torsoId',
  'armLId',
  'armRId',
  'legLId',
  'legRId',
  'hatId',
  'backId',
] as const satisfies readonly (keyof AvatarAppearance)[];

export const PROPORTION_KEYS = [
  'height',
  'shoulderWidth',
  'armLength',
  'legOffsetX',
  'torsoScaleX',
  'neckHeight',
  'headScale',
] as const satisfies readonly (keyof AvatarProportions)[];

/**
 * Bloxity spells "nothing equipped" several ways.
 *
 * The SDK's own catalogue code tests for `'-1'`, and null, empty and the
 * string `'undefined'` all turn up in practice. One predicate, so a slot that
 * means "none" cannot be read as an id by one side and a blank by the other.
 */
const isNone = (id: string): boolean =>
  id === '' || id === '-1' || id === 'undefined' || id === 'null';

/**
 * A catalogue id, or the empty string.
 *
 * Bloxity ids are 24-character hex object ids, but the built-in items use
 * short numeric ones, so the shape is deliberately permissive and the LENGTH
 * is what is really being bounded: this string is replicated to every client
 * and pasted into a URL, so a client that sent a kilobyte of anything must not
 * be able to make everyone else fetch it.
 */
const cleanId = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (isNone(trimmed)) return '';
  if (trimmed.length > 32) return '';
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : '';
};

/**
 * Clamp one proportion.
 *
 * A multiplier, so the neutral is 1 and the bounds are generous but real: a
 * NaN would poison a matrix, and an unbounded value is a player who can make
 * themselves a mile tall on everybody else's screen.
 */
const cleanProportion = (raw: unknown): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0.25), 4);
};

/** Everything a client sends about its own appearance passes through here. */
export const sanitizeAppearance = (raw: unknown): AvatarAppearance => {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_APPEARANCE };
  for (const slot of AVATAR_SLOTS) out[slot] = cleanId(source[slot]);
  return out;
};

export const sanitizeProportions = (raw: unknown): AvatarProportions => {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PROPORTIONS };
  for (const key of PROPORTION_KEYS) out[key] = cleanProportion(source[key]);
  return out;
};

/** True when two looks would draw identically, so nothing is rebuilt for free. */
export const sameAppearance = (a: AvatarAppearance, b: AvatarAppearance): boolean =>
  AVATAR_SLOTS.every((slot) => a[slot] === b[slot]);

export const sameProportions = (a: AvatarProportions, b: AvatarProportions): boolean =>
  PROPORTION_KEYS.every((key) => a[key] === b[key]);

/** Nothing equipped at all - the player is signed out, or wearing defaults. */
export const isDefaultAppearance = (a: AvatarAppearance): boolean =>
  AVATAR_SLOTS.every((slot) => a[slot] === '');
