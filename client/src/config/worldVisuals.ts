/**
 * THE PALETTE: a mech facility at night.
 *
 * COLOUR ONLY. Every world coordinate lives in `@robot/shared`'s course
 * config, so this file re-themes the entire game without moving a single
 * collider.
 *
 * Taken from the reference art, and it is four colours doing four jobs:
 *
 *  - SLATE NAVY is the building. Bulkheads, deck plate, machine housings, the
 *    metal between the lights. Almost everything is this.
 *
 *    DARK, BUT NEVER BLACK. The building is what the player walks on, jumps
 *    between and reads a route across, so every structural surface has to have
 *    a visible face and a visibly darker one beside it. An earlier pass took
 *    these down to near-black and the result was a room with the lights off:
 *    neon outlines floating in front of nothing. Structural colours live from
 *    about #222a38 up; only the void and the pit floor go below that, because
 *    those two are meant to read as nothing at all.
 *  - ELECTRIC LIME is the facility's own light. The tall column lamps, the
 *    floor seams, the door frames, the energy platforms. It means POWER ON.
 *  - MAGENTA is the warning circuit. Ceiling strips, hazard trim, the glow
 *    spilled on the deck under a lamp. It means EDGE, RAIL, KEEP OUT.
 *  - WHITE is the ceiling. Flat recessed panels, and nothing else in the world
 *    is allowed to be plain white, so a white rectangle always reads as a lamp.
 *
 * LAVENDER is the fifth and it is reserved: everything that can kill you is
 * lavender and nothing else is. A colour is a promise here.
 *
 * Every texture is drawn on a canvas at runtime, so the whole style costs
 * nothing against the 12 MB budget.
 */
export const PALETTE = {
  /** Deck plate: the course floor, and the most-seen surface in the game. */
  grass: '#262f40',
  grassStud: '#323d52',
  /** The hangar deck: the same plate, warmer, with more wear in it. */
  lobbyGrass: '#2b3547',
  lobbyGrassStud: '#3a4559',

  /** Bulkhead panelling, boxing the whole facility in. */
  wall: '#2f3a4e',
  wallDark: '#1b2231',
  wallSpeck: 'rgba(150,180,255,0.14)',

  /** The lit rail capping every bulkhead. Magenta: it means "edge". */
  hedge: 0xff2fd0,
  hedgeDark: 0x7a1266,

  /** Structural steel: catwalks, gantries, girders. */
  wood: '#39445a',
  woodDark: '#252e3e',
  woodSpeck: 'rgba(0,0,0,0.35)',

  /** Support columns, and the lit collar they carry. */
  pillar: 0x232b3b,
  pillarTop: 0xd8ff3a,

  /**
   * THE HAZARDS. Lavender, all of them, and that is a promise rather than a
   * preference: in a facility this dark, a beam the colour of the machinery it
   * sweeps over is invisible until it has already hit.
   */
  hazard: 0xc9b0ff,
  hazardRim: 0x9d7bff,

  /** Emitters: dark stems with blazing tips, seen from above. */
  spike: 0x3d4557,
  spikeTip: 0xff5ec8,

  /**
   * ENERGY PLATFORMS - the surface the whole course is played on.
   *
   * The facility's own lime, and the single most important colour in the game:
   * it means "the floor the machine made". Shared by the platforms, the launch
   * pads, the door frames and the deck seams, so a player learns in the first
   * stage that lime is where they are meant to be.
   */
  rune: 0x3c5312,
  runeEdge: 0xd8ff3a,
  runeGlow: 0xa8e021,

  /** The gold clearance pad at the end of every stage. */
  winPad: '#ffc51f',
  winPadAlt: '#ffe89a',
  /**
   * The dark plinth the gold plate is inset into.
   *
   * Nearly black, and deliberately darker than the deck it stands on: the
   * border's whole job is to separate a bright plate from whatever colour the
   * floor is in that section of the facility.
   */
  winPadRim: 0x121824,
  /** The RETURN pad opposite it: lime, and worth nothing. */
  returnPad: '#2f4410',
  returnPadAlt: '#d8ff3a',

  /** Mech bay plinths and their floor rings. */
  standBase: 0x2b3546,
  standTop: 0xd8ff3a,
  standLocked: 0x3a4459,
  standHalo: 0xd8ff3a,
  standHaloLocked: 0x2a3320,

  /** Dead service masts behind the bulkheads. */
  trunk: 0x353e52,
  canopyA: 0x2a3344,
  canopyB: 0x222a39,

  /** Torn hull plate: the collapsed sections, and the sentinel's own grey. */
  ruin: 0x54607a,
  ruinDark: 0x39425a,

  /** THE VOID: the bottom of the shafts that open onto nothing at all. */
  quicksand: '#05070d',
  quicksandDark: '#020306',

  /** The pit floor under the whole world, so a fall has a bottom. */
  pitFloor: 0x080b12,

  /** The test bay, its treads and its frames. */
  deck: '#2c3547',
  deckDark: '#1d2432',
  /** ONE frame colour, because there is ONE kind of test rig. */
  treadmillFrame: 0x00cfff,
  treadmillFrameDark: 0x0a2230,
  treadmillBelt: 0x1b2230,
  treadmillScreen: 0x061018,
  treadmillScreenLit: 0x00cfff,

  /** Facility signage: an amber board is the only warm thing in the building. */
  boardAmber: 0xff8c1a,
  boardAmberEdge: 0xffc24d,

  /** A platform about to drop flashes toward this. */
  sinkingWarn: 0xff5a2a,

  /* ---- Section materials -------------------------------------------------
   * Each section of the facility gets its own housing rather than a recolour
   * of the corridor, because thirty stages through one tunnel reads as one
   * very long stage.
   */

  /** Polished plating: coolant floors and frictionless test surfaces. */
  ice: '#3c647a',
  iceStud: '#7fd6f0',

  /** Cast machine housing: reactor shells, tower casings, steppers. */
  stone: '#37415a',
  stoneDark: '#242c3e',

  /** Structural girders, warmer than the catwalks. */
  log: '#454a5c',
  logDark: '#2c303e',

  /** Black machine steel: press frames, rails, conveyor housings. */
  /*
   * THE HANGAR DOOR, and it is the one place hazard chevrons appear on
   * architecture rather than on a pad.
   *
   * Dark plate with amber chevrons: the marking every loading door in the
   * world wears, which is why a player reads it as a door before they have
   * looked at its frame. Amber is also the one warm colour in the building, so
   * the door cannot be confused with the lime that means "powered" or the
   * magenta that means "warning".
   */
  /** The dark glass every lit display in the facility is faced with. */
  boardFace: 0x0a1a24,
  doorPlate: '#3a4230',
  doorChevron: '#c9a32a',
  metal: 0x333c50,
  metalDark: 0x1f2633,

  /** Molten coolant. Bright, and the one thing in the world that truly emits. */
  lava: '#ff6a1e',
  lavaDark: '#a82405',
  /** Cryogen, at the bottom of the open bays. */
  water: '#1fb6e0',
  waterDark: '#0d6d96',

  /** Debris, and the blocks that fall out of the dark. */
  rock: 0x4c5570,
  rockDark: 0x343c50,

  /** A lamp's own colour, and the plasma funnels. */
  flame: 0xd8ff3a,
  tornado: 0x9fe8ff,

  /** The warning patch under something that is about to land on you. */
  impactWarn: 0x2a1a2f,

  /* ---- Command displays --------------------------------------------------
   * Dark glass in a steel case, lit from inside. The panel is DARK, so the
   * text on it is light and its outline dark - the opposite way round from
   * every other sign in this game, which is why `boardInk` is the header's
   * stroke rather than white.
   */
  boardFrame: 0x313b4e,
  boardFrameDark: 0x1e2533,
  boardPanel: '#070c14',
  boardPanelEdge: '#16324a',
  boardStripe: 'rgba(216, 255, 58, 0.07)',
  boardInk: '#02040a',
  boardHeading: '#d8ff3a',
  boardName: '#ffffff',
  boardValue: '#00e5ff',

  /**
   * The far dark of the facility, and the fog matched to it.
   *
   * Not a sky: it is the depth of a building too big to light. A gradient dome
   * so there is no visible seam where the world ends, and the fog takes its
   * colour from the dome's lower band for the same reason.
   */
  sky: 0x0b1120,
  fog: 0x18203a,
  /** Banks of vented steam, high up. Two tones: a lit top and a dark base. */
  cloud: 0x243049,
  cloudShade: 0x18202f,
} as const;

/**
 * Fog band.
 *
 * Held BACK, so the fog is depth rather than a curtain.
 *
 * It used to start at 190 units, which put a haze over the far half of every
 * room the player was standing in - and combined with near-black materials
 * that is what made the facility look unlit rather than large. Starting it
 * past the length of a hall means what fades is the next hall, which is the
 * only thing fog was ever meant to do here.
 */
export const WORLD_FOG = {
  near: 320,
  far: 1100,
} as const;

/** How far apart the service masts stand along the corridor. */
export const SCENERY = {
  treeSpacingZ: 62,
  treeOffsetX: 26,
  trunkMin: 12,
  trunkMax: 22,
} as const;

/**
 * Yaw correction for the supplied pilot FBX.
 *
 * player.fbx already faces +Z; the offset exists so a re-authored model can be
 * corrected without touching gameplay code.
 */
export const PLAYER_MODEL_YAW_OFFSET = 0;

/**
 * THE SECTION ACCENT: one lit colour per stage, and thirty of them.
 *
 * A thirty-stage run through one facility has a problem the individual stages
 * cannot solve: however different their obstacles are, a player running them
 * back to back is looking at the same corridor for twenty minutes. The answer
 * is the answer a real building gives - each section of the plant is LIT
 * differently, and the light is the first thing you notice when you walk
 * through the door.
 *
 * The accent drives the lamp columns down that stage's walls, the wash they
 * throw on its deck, its strip lights, its beacons and the trim on its gate.
 * The architecture is identical everywhere on purpose; the LIGHT is what tells
 * a player which part of the facility they are in.
 *
 * Grouped so neighbours differ and the difficulty bands read as districts:
 * lime through the hangar and the first assembly halls, cyan across the
 * cryogenic and coolant sections, amber in the foundries, violet in the deep
 * machine spaces, and magenta closing the run at the reactor - where the
 * facility's own warning colour finally becomes the room you are standing in.
 *
 * COLOUR ONLY, as everything in this file is. Nothing here moves a collider,
 * and a stage's geometry does not know which colour it is lit by.
 */
export const STAGE_ACCENT: readonly number[] = [
  0xd8ff3a, // 1  Mech Hangar Escape - the hangar's own lime
  0x8bff6a, // 2  Reactor Platform
  0xd8ff3a, // 3  Falling Machinery
  0x5dff9e, // 4  Industrial Maze
  0x00e5ff, // 5  Energy Bridge - the coolant district opens
  0x5df2ff, // 6  Reactor Core
  0x00e5ff, // 7  Moving Cargo Platforms
  0x35e0ff, // 8  Laser Grid Facility
  0xffb545, // 9  Mechanical Crusher Hall - the foundries
  0xff8f2e, // 10 Suspended Factory
  0xffb545, // 11 Vertical Reactor Shaft
  0xffd76b, // 12 Collapsing Platforms
  0xff8f2e, // 13 Giant Gear Facility
  0x00e5ff, // 14 Energy Conveyor - back into coolant
  0x5df2ff, // 15 Mech Testing Chamber
  0x7df9ff, // 16 Industrial Tunnel
  0x35e0ff, // 17 Reactor Cooling Zone
  0xc9b0ff, // 18 Moving Wall Facility - the deep machine spaces
  0xa98bff, // 19 Multi-Level Factory
  0xc9b0ff, // 20 Gravity Platform Section
  0x8b6bff, // 21 Energy Core Maze
  0xa98bff, // 22 Giant Machinery Room
  0xd8ff3a, // 23 Mech Assembly Facility - the assembly halls, lit like home
  0x8bff6a, // 24 Reactor Bridge
  0xd8ff3a, // 25 Vertical Hangar
  0xff2fd0, // 26 Mechanical Gauntlet - the reactor district
  0xff5fe0, // 27 Collapsing Factory
  0xff2fd0, // 28 Core Defense Facility
  0xff3d6a, // 29 Final Reactor
  0xff2fd0, // 30 MECH ESCAPE
];

/**
 * The accent for a stage index, and the hangar's lime for anything outside the
 * run - the lobby, the aprons, the strip of world past the last gate.
 */
export const accentForStage = (stage: number): number =>
  STAGE_ACCENT[stage - 1] ?? PALETTE.runeEdge;
