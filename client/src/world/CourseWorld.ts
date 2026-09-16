import {
  COURSE,
  COURSE_END_Z,
  COURSE_SOLIDS,
  DECORATIONS,
  corridorHalfWidthAt,
  formatSpeed,
  QUICKSAND,
  stageAt,
  STAGES,
  TRAINING,
  WIDE_AREAS,
  WIN_PAD,
  WorldCollision,
  type CourseSolid,
  type SolidKind,
} from '@robot/shared';
import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Scene,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accentForStage, PALETTE, SCENERY } from '../config/worldVisuals.js';
import { RobotStands } from './RobotStands.js';
import { CanvasSign } from './CanvasSign.js';
import { loadSharedImage, onImageDecoded } from './ImageBillboard.js';
import { WinTrophies } from './WinTrophies.js';
import { Scoreboard } from './Scoreboard.js';
import { Guardian } from './Guardian.js';
import { Hazards } from './Hazards.js';
import { SinkingPlatforms } from './SinkingPlatforms.js';
import { Sky } from './Sky.js';
import { StageSigns } from './StageSigns.js';
import { TrainingArea } from './TrainingArea.js';
import { WorldTextures } from './WorldTextures.js';
import { texturedBox } from './texturedBox.js';

/** World units one repeat of a tiling texture covers. */
const TILE = 6;

/**
 * The win pads' glow, and the breath it runs on.
 *
 * ONE table, because the pad, the halo lying over it and the trophy bobbing
 * above it all ride the same sine - and three effects that drifted apart would
 * read as three things happening near each other rather than as one pad being
 * alive. `rate` is radians a second: a breath every three seconds or so, slow
 * enough to be felt rather than watched.
 */
/**
 * The dark plinth the gold plate is inset into, and the cups standing on it.
 *
 * `margin` is how much dark border shows around the plate on every side, which
 * is the whole reason the plinth exists. The cups are authored as fractions of
 * the pad so they stay where they are meant to be if a pad is ever resized.
 */
const PLINTH = { margin: 1.8, height: 0.42 } as const;

/** World units tall a pad cup is, before its own scale. */
const CUP_HEIGHT = 2.6;

/**
 * Where the cups stand, as fractions of the pad's half-extent.
 *
 * Scattered rather than ranked: the reference has a few sitting about the
 * plate as though somebody put them down, and a neat row would read as
 * furniture. One hovers - the little one off the front corner - because a
 * prize that is all on the floor has nothing drawing the eye up to the sign.
 */
const CUPS = [
  { x: -0.62, z: 0.34, scale: 1, lift: 0 },
  { x: 0.46, z: -0.18, scale: 0.86, lift: 0 },
  { x: -0.18, z: 0.72, scale: 0.62, lift: 1.9 },
] as const;

const WIN_GLOW = {
  base: 0.35,
  swing: 0.3,
  haloBase: 0.16,
  haloSwing: 0.16,
  rate: 2.1,
} as const;

/**
 * The supplied trophy art, served from the repo-level `assets/` folder.
 *
 * Vite publishes that folder as the web root, so this path is what the file is
 * reachable at in dev and in the build alike.
 */
const TROPHY_URL = '/ui/trophy.png';

/**
 * The visible world.
 *
 * Every solid it draws comes from `COURSE_SOLIDS` - the SAME array the
 * collision model is built from - so a platform the player can see but not
 * stand on is structurally impossible. `CourseWorld` is the visuals and
 * `WorldCollision` is the gameplay shape, and they cannot drift apart because
 * neither owns a coordinate.
 *
 * Geometry is merged per material, so a three-thousand-unit world with eight
 * stages is a couple of dozen draw calls rather than a few hundred meshes.
 */
/**
 * The geometry list for one lit colour, made on first use.
 *
 * Lit hardware is grouped by COLOUR rather than by what it is, because that is
 * what decides the material: every lamp in the facility that burns the same
 * colour ends up in one merged mesh however far apart the two ends of it are.
 */
const bucket = (
  into: Map<number, BufferGeometry[]>,
  color: number,
): BufferGeometry[] => {
  const found = into.get(color);
  if (found) return found;
  const made: BufferGeometry[] = [];
  into.set(color, made);
  return made;
};

export class CourseWorld {
  readonly root = new Group();

  /** The gameplay shape of the same data. Shared with the local prediction. */
  readonly collision = new WorldCollision();

  readonly hazards: Hazards;
  readonly stands: RobotStands;
  readonly signs: StageSigns;
  readonly training: TrainingArea;
  readonly sinking: SinkingPlatforms;
  readonly guardian: Guardian;
  /** The three leaderboards on the back wall of the spawn arena. */
  readonly scoreboard: Scoreboard;
  readonly sky: Sky;

  private readonly textures = new WorldTextures();
  private readonly materials: Material[] = [];
  private readonly winSigns: CanvasSign[] = [];
  /**
   * The little cups sitting on every win pad, as ONE merged mesh.
   *
   * Held so the idle bob is a single transform for the whole course. Built
   * once the trophy art has decoded - see `buildWinPadCups`.
   */
  private cupMesh: Mesh | null = null;

  /**
   * The win pads' own glow, and the halo lying over them.
   *
   * Held as fields so the pulse is TWO numbers written per frame for the whole
   * course - one emissive intensity and one opacity, both on materials shared
   * by all thirty pads. A per-pad animation would be thirty objects touched
   * every frame for an effect nobody is looking at from more than one of them.
   */
  private winPadMaterial: MeshLambertMaterial | null = null;
  private winHaloMaterial: MeshLambertMaterial | null = null;

  /** The trophy burst an award plays. Lives here so the world owns its scene. */
  readonly winTrophies = new WinTrophies();

  /** Free-running clock for the win pads' idle pulse. */
  private glowTime = 0;

  constructor() {
    this.buildSolids();
    this.buildPitFloor();
    this.buildQuicksand();
    this.buildWalls();
    this.buildScenery();
    this.buildDecorations();
    this.buildWinPadSigns();

    // The award effect lives in the world so it is torn down with it, and so
    // the only thing `Game` has to do on a win is say where the player is.
    this.root.add(this.winTrophies.root);

    this.hazards = new Hazards();
    this.root.add(this.hazards.root);

    this.sinking = new SinkingPlatforms(
      this.textures.stone(PALETTE.stone, PALETTE.stoneDark),
    );
    this.root.add(this.sinking.root);

    this.stands = new RobotStands();
    this.root.add(this.stands.root);

    this.signs = new StageSigns();
    this.root.add(this.signs.root);

    this.training = new TrainingArea(
      // CYAN chevrons, not lavender: lavender is what kills you in this
      // facility and nothing else may wear it, least of all the one surface in
      // the building a player is invited to stand on and hold W.
      this.textures.belt(hex(PALETTE.treadmillBelt), '#5df2ff'),
    );
    this.root.add(this.training.root);

    this.guardian = new Guardian();
    this.root.add(this.guardian.root);

    this.scoreboard = new Scoreboard();
    this.root.add(this.scoreboard.root);

    this.sky = new Sky();
    this.root.add(this.sky.root);
  }

  addTo(scene: Scene): void {
    scene.add(this.root);
  }

  /**
   * @param elapsed the server's clock, replicated. The rolling balls and the
   *                sinking platforms are pure functions of it, so drawing them
   *                from it is what makes what is on screen the same thing the
   *                server will kill with.
   */
  update(delta: number, elapsed: number): void {
    this.hazards.update(elapsed);
    this.sinking.update(elapsed);
    this.stands.update(delta);
    this.training.update(delta);
    this.guardian.update(delta);
    this.pulseWinPads(delta);
    this.winTrophies.update(delta);
  }

  dispose(): void {
    this.textures.dispose();
    for (const material of this.materials) material.dispose();
    for (const sign of this.winSigns) sign.dispose();
    this.cupMesh?.geometry.dispose();
    this.winTrophies.dispose();
    this.hazards.dispose();
    this.sinking.dispose();
    this.stands.dispose();
    this.signs.dispose();
    this.training.dispose();
    this.guardian.dispose();
    this.scoreboard.dispose();
    this.sky.dispose();
    this.root.removeFromParent();
  }

  /** Draw every solid, grouped by kind so each group is one mesh. */
  private buildSolids(): void {
    const byKind = new Map<SolidKind, BufferGeometry[]>();

    for (const solid of COURSE_SOLIDS) {
      const list = byKind.get(solid.kind) ?? [];
      list.push(boxFor(solid, TILE));
      byKind.set(solid.kind, list);
    }

    for (const [kind, geometries] of byKind) {
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;

      const mesh = new Mesh(merged, this.materialFor(kind));
      mesh.receiveShadow = true;
      mesh.castShadow =
        kind === 'block' || kind === 'pillar' || kind === 'plank' || kind === 'ruin';
      this.root.add(mesh);
    }
  }

  /**
   * The bottom of the world.
   *
   * One slab under everything. Without it a fall shows the underside of the
   * course and an infinite void, which is exactly what makes a map look
   * unfinished - and it is not a cover-up, because the death plane sits well
   * ABOVE it: the player dies looking at a floor they were falling toward,
   * rather than into nothing.
   */
  private buildPitFloor(): void {
    const widest = Math.max(
      COURSE.lobbyHalfWidth,
      ...WIDE_AREAS.map((area) => area.halfWidth),
    );
    const width = widest * 2 + 120;
    const from = COURSE.lobbyStartZ - 60;
    const to = COURSE_END_Z + 60;

    const floor = texturedBox(width, 6, to - from, TILE * 2);
    floor.translate(0, COURSE.pitFloorY - 3, (from + to) / 2);
    const mesh = new Mesh(floor, this.solidMaterial(PALETTE.pitFloor));
    mesh.receiveShadow = true;
    this.root.add(mesh);

    // The sides of the plateau the world sits on, so the drop reads as a cliff
    // with a bottom rather than as a slab hanging in space.
    const skirts: BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const skirt = texturedBox(8, COURSE.pitFloorY * -1, to - from, TILE);
      skirt.translate(
        side * (widest + 30),
        COURSE.pitFloorY / 2,
        (from + to) / 2,
      );
      skirts.push(skirt);
    }
    this.addMerged(skirts, this.solidMaterial(PALETTE.pitFloor), true);
  }

  /**
   * The bottom of every pit, in whatever the pit is made of.
   *
   * Lava, void and water kill by exactly the same rule and are drawn by
   * exactly the same box - grouped by material so the three of them still cost
   * three meshes rather than one per pit. The mechanic is shared on purpose;
   * only the look is not, which is what lets a dozen stages use it without
   * reading as the same stage a dozen times.
   */
  private buildQuicksand(): void {
    if (QUICKSAND.length === 0) return;

    const byMaterial = new Map<string, BufferGeometry[]>();
    for (const pit of QUICKSAND) {
      const geometry = texturedBox(
        pit.maxX - pit.minX,
        1.5,
        pit.maxZ - pit.minZ,
        TILE,
      );
      geometry.translate(
        (pit.minX + pit.maxX) / 2,
        pit.surfaceY - 0.75,
        (pit.minZ + pit.maxZ) / 2,
      );
      const list = byMaterial.get(pit.surface);
      if (list) list.push(geometry);
      else byMaterial.set(pit.surface, [geometry]);
    }

    for (const [surface, parts] of byMaterial) {
      if (surface === 'lava') {
        // The one emissive material in the world. Lava that took the scene's
        // lighting like everything else would read as orange rock.
        const map = this.textures.sand(PALETTE.lava, PALETTE.lavaDark);
        const material = new MeshLambertMaterial({ map });
        material.emissive.setHex(0xff5a12);
        material.emissiveIntensity = 0.65;
        material.emissiveMap = map;
        this.materials.push(material);
        this.addMerged(parts, material, false);
        continue;
      }
      // The VOID is the default, which is right for this game: most of what
      // is under these platforms is nothing at all.
      const colours =
        surface === 'water'
          ? [PALETTE.water, PALETTE.waterDark]
          : [PALETTE.quicksand, PALETTE.quicksandDark];
      this.addMerged(
        parts,
        this.texturedMaterial(
          this.textures.sand(colours[0] as string, colours[1] as string),
        ),
        true,
      );
    }
  }

  /**
   * The pink walls that box the world in, capped with green hedge.
   *
   * These are SCENERY. What actually holds the player in is
   * `WorldCollision.clampToBounds`, which is applied after the substep has
   * already integrated and therefore cannot be tunnelled at any speed.
   */
  /**
   * THE BUILDING: bulkheads, lamp columns, ceiling panels and gantries.
   *
   * This is the single biggest thing on screen at any moment and it is built
   * from four parts, each doing one job the reference facility does:
   *
   *  - RIBBED BULKHEADS box the corridor in. Panelled, spliced at storey
   *    height, and TALL - a wall a mech cannot see the top of is what makes a
   *    mech feel like it is indoors rather than in a pen.
   *  - LAMP COLUMNS are the light. Enormous lit bars standing proud of the
   *    wall at a regular pitch, with a magenta wash spilled on the deck at
   *    their feet. They are the rhythm of the whole facility: everything else
   *    is dark, so the eye reads distance by counting them.
   *  - CEILING PANELS are flat white rectangles recessed into the roof. The
   *    only plain white in the world, which is why one always reads as a lamp.
   *  - GANTRIES cross overhead between the bulkheads: a girder, two hangers
   *    and a pipe run. They do nothing and they are the reason the space above
   *    the player has a scale at all.
   *
   * Everything merges into one mesh per material, so a two-kilometre corridor
   * is about eight draw calls.
   */
  private buildWalls(): void {
    const thickness = 8;
    const walls: BufferGeometry[] = [];
    const rails: BufferGeometry[] = [];
    /*
     * The lit hardware is bucketed BY COLOUR, because the corridor is lit
     * differently in every section (see STAGE_ACCENT). A bucket per colour is
     * one merged mesh per colour - six draw calls for the whole facility,
     * rather than one per stage.
     */
    const lamps = new Map<number, BufferGeometry[]>();
    const wash = new Map<number, BufferGeometry[]>();
    /** The colour of the section this Z falls in; the hangar's lime outside one. */
    const accentAtZ = (z: number): number => {
      const stage = stageAt(z);
      return stage ? accentForStage(stage.index) : PALETTE.runeEdge;
    };
    const panels: BufferGeometry[] = [];
    const steel: BufferGeometry[] = [];

    /** Pitch of the lamp columns along the corridor, in world units. */
    const LAMP_PITCH = 52;
    /** Pitch of the overhead gantries. Offset from the lamps, deliberately. */
    const GANTRY_PITCH = 104;

    const run = (halfWidth: number, fromZ: number, toZ: number): void => {
      const length = toZ - fromZ;
      if (length <= 0) return;
      const centreZ = (fromZ + toZ) / 2;
      const top = COURSE.wallHeight - COURSE.floorThickness;

      for (const side of [-1, 1]) {
        const x = side * (halfWidth + thickness / 2);
        const wall = texturedBox(thickness, COURSE.wallHeight, length, TILE);
        wall.translate(x, COURSE.wallHeight / 2 - COURSE.floorThickness, centreZ);
        walls.push(wall);

        // The lit rail capping the bulkhead, and a second one at deck level:
        // two lines the eye can follow the length of a corridor.
        const cap = texturedBox(thickness + 2.5, 2.2, length, TILE);
        cap.translate(x, top + 1.1, centreZ);
        rails.push(cap);
        const kerb = texturedBox(1.2, 1.2, length, TILE);
        kerb.translate(side * (halfWidth - 0.4), COURSE.floorY + 0.6, centreZ);
        rails.push(kerb);
      }

      /*
       * THE LAMP COLUMNS.
       *
       * Deterministic pitch from world zero rather than from the span, so a
       * corridor that changes width mid-run does not restart its own rhythm -
       * the lights are part of the building, not part of the section.
       */
      const first = Math.ceil(fromZ / LAMP_PITCH) * LAMP_PITCH;
      for (let z = first; z < toZ; z += LAMP_PITCH) {
        /*
         * The lamp takes the colour of the SECTION it stands in.
         *
         * This is the one line that gives thirty stages thirty identities: the
         * corridor is deliberately the same building all the way down, and the
         * light is what changes. The bucket is keyed by colour rather than by
         * stage, so the whole run still merges into one mesh per colour - six
         * of them across thirty stages, not thirty.
         */
        const accent = accentAtZ(z);
        for (const side of [-1, 1]) {
          /*
           * NO COLUMN BEHIND THE CALIBRATION BAY'S SIGNAGE.
           *
           * The bay's board and captions hang on this wall, and a column is
           * sixty-eight units of lit lime against a board nineteen tall: it
           * shows above it, below it, and straight through the transparent
           * parts of the text, which put three bright verticals across the one
           * sign in the room. Moving the sign does not help - the column is
           * taller than the thing in front of it from every angle a player
           * reads it at.
           *
           * Only the bay's own side and only its own stretch of wall. The mech
           * bay opposite keeps its columns, and so does every other unit of
           * the corridor; the bay is lit by the board's own bezel and by the
           * screens on the rigs.
           */
          if (side < 0 && z > TRAINING.minZ - 20 && z < TRAINING.maxZ + 20) continue;

          const x = side * (halfWidth - 1.6);
          const height = COURSE.wallHeight * 0.62;
          const housing = texturedBox(3.4, height + 3, 5.2, TILE);
          housing.translate(x, height / 2 + 2, z);
          steel.push(housing);

          const bar = texturedBox(2.2, height, 3.4, TILE);
          bar.translate(side * (halfWidth - 2.6), height / 2 + 3, z);
          bucket(lamps, accent).push(bar);

          // The wash on the deck. A thin slab just proud of the floor, so the
          // light reads as coming from somewhere rather than being painted on.
          const pool = texturedBox(13, 0.16, 15, TILE);
          pool.translate(side * (halfWidth - 6), COURSE.floorY + 0.09, z);
          bucket(wash, accent).push(pool);
        }
      }

      /*
       * CEILING PANELS and GANTRIES.
       *
       * Both hang from the roof line rather than from a stage's own ceiling,
       * which is per-stage and can be two hundred units up. These are the
       * BUILDING's roof - the thing a player looks up at in a corridor - and a
       * fixed height is what keeps the facility feeling like one place.
       */
      const roof = COURSE.wallHeight - COURSE.floorThickness - 2;
      for (let z = first; z < toZ; z += LAMP_PITCH / 2) {
        const panel = texturedBox(halfWidth * 0.34, 0.9, 11, TILE);
        panel.translate(0, roof, z);
        panels.push(panel);
      }

      const firstGantry = Math.ceil(fromZ / GANTRY_PITCH) * GANTRY_PITCH;
      for (let z = firstGantry; z < toZ; z += GANTRY_PITCH) {
        const girder = texturedBox(halfWidth * 2 + thickness, 3.2, 4.5, TILE);
        girder.translate(0, roof - 7, z);
        steel.push(girder);
        const pipe = texturedBox(halfWidth * 2, 1.8, 1.8, TILE);
        pipe.translate(0, roof - 11.5, z + 4.5);
        steel.push(pipe);
        for (const side of [-1, 1]) {
          const hanger = texturedBox(1.4, 7, 1.4, TILE);
          hanger.translate(side * halfWidth * 0.55, roof - 3.5, z);
          steel.push(hanger);
        }
      }
    };

    /**
     * A shoulder wall where the world changes width.
     *
     * Without one, a wide area meets a narrow corridor with an open gap either
     * side and the player looks straight out of the map. Built from the SAME
     * two widths the boundary uses, so it always exactly closes the step.
     */
    const shoulder = (wideHalf: number, narrowHalf: number, atZ: number): void => {
      const span = wideHalf - narrowHalf;
      if (span <= 0.01) return;
      for (const side of [-1, 1]) {
        const piece = texturedBox(span, COURSE.wallHeight, thickness, TILE);
        piece.translate(
          side * (narrowHalf + span / 2),
          COURSE.wallHeight / 2 - COURSE.floorThickness,
          atZ,
        );
        walls.push(piece);
        // A lit reveal down the inside of the step, so a change of width reads
        // as a doorway rather than as a mistake.
        const reveal = texturedBox(1.2, COURSE.wallHeight * 0.8, 1.2, TILE);
        reveal.translate(
          side * (narrowHalf + 1),
          COURSE.wallHeight * 0.4 - COURSE.floorThickness,
          atZ,
        );
        bucket(lamps, accentAtZ(atZ)).push(reveal);
      }
    };

    // Walk the world from the hangar's back wall to the end, splitting at every
    // change of width. The spans come from WIDE_AREAS - the same list the
    // movement clamp reads - so a wall can never end up somewhere the boundary
    // is not.
    const end = COURSE_END_Z + 10;
    const boundaries = [COURSE.lobbyStartZ, end];
    for (const area of WIDE_AREAS) {
      boundaries.push(area.minZ, area.maxZ);
    }
    const marks = [...new Set(boundaries)]
      .filter((z) => z >= COURSE.lobbyStartZ && z <= end)
      .sort((a, b) => a - b);

    for (let i = 0; i < marks.length - 1; i += 1) {
      const fromZ = marks[i] as number;
      const toZ = marks[i + 1] as number;
      if (toZ - fromZ < 0.01) continue;
      // Sampled at the MIDDLE of the span: a boundary value would land exactly
      // on the edge of a wide area and could resolve either way.
      const halfWidth = corridorHalfWidthAt((fromZ + toZ) / 2);
      run(halfWidth, fromZ, toZ);

      const nextZ = marks[i + 2];
      const nextHalf =
        nextZ === undefined ? halfWidth : corridorHalfWidthAt((toZ + nextZ) / 2);
      if (nextHalf > halfWidth) shoulder(nextHalf, halfWidth, toZ - thickness / 2);
      else shoulder(halfWidth, nextHalf, toZ + thickness / 2);
    }

    // The hangar's back wall, and the shutter door set into it. The shutter
    // gets its own array because it gets its own MATERIAL: a door drawn in the
    // wall's steel is a door nobody sees.
    const shutter: BufferGeometry[] = [];
    const back = texturedBox(
      COURSE.lobbyHalfWidth * 2 + thickness * 2,
      COURSE.wallHeight,
      thickness,
      TILE,
    );
    back.translate(
      0,
      COURSE.wallHeight / 2 - COURSE.floorThickness,
      COURSE.lobbyStartZ - thickness / 2,
    );
    walls.push(back);
    this.pushHangarDoor(steel, shutter, lamps, COURSE.lobbyStartZ + 0.6);

    this.addMerged(walls, this.brickMaterial(), true);
    this.addMerged(steel, this.texturedMaterial(
      this.textures.stone(PALETTE.stone, PALETTE.stoneDark),
    ), true);
    this.addMerged(shutter, this.texturedMaterial(
      this.textures.goldCheck(PALETTE.doorPlate, PALETTE.doorChevron),
    ), true);
    this.addMerged(rails, this.emissiveMaterial(PALETTE.hedge, 0.55), true);
    for (const [color, parts] of lamps) {
      this.addMerged(parts, this.emissiveMaterial(color, 1.25), false);
    }
    for (const [color, parts] of wash) {
      this.addMerged(parts, this.emissiveMaterial(color, 0.5), false);
    }
    this.addMerged(panels, this.emissiveMaterial(0xffffff, 1.1), false);
  }

  /**
   * THE HANGAR DOOR in the back wall.
   *
   * A huge sealed shutter - segmented, framed, and lit down both jambs. It is
   * the first thing a player sees when they turn round at spawn, and it is the
   * whole reason the room reads as a hangar rather than as a corridor that
   * happens to be wide: a door that big only exists for something that big.
   *
   * It is decoration. Nothing opens it and nothing is behind it.
   */
  private pushHangarDoor(
    steel: BufferGeometry[],
    shutter: BufferGeometry[],
    lamps: Map<number, BufferGeometry[]>,
    z: number,
  ): void {
    const width = COURSE.lobbyHalfWidth * 0.9;
    const height = COURSE.wallHeight * 0.66;

    /*
     * Eight shutter segments in DOOR PLATE - chevroned, and standing proud of
     * the bulkhead.
     *
     * The first version drew them in the same steel as the wall around them,
     * which made the largest object in the hangar invisible: a flat rectangle
     * of wall texture inside a frame reads as a panel join. Hazard chevrons
     * are the marking every loading door on earth wears, the plates step 2.5
     * units forward of the wall face, and a lit bar sits in every seam - so it
     * reads as a door from the far end of the room.
     */
    const segments = 8;
    const h = height / segments;
    /*
     * The chevrons are tiled at THREE TIMES the building's scale.
     *
     * At the world tile the hazard markings repeated fourteen times across the
     * door and read as a grid rather than as chevrons - which is the failure
     * mode of every small-repeat texture on a very large object. Three metres
     * of stripe per repeat is roughly what a real loading door wears.
     */
    const doorTile = TILE * 3;
    for (let i = 0; i < segments; i += 1) {
      const plate = texturedBox(width, h * 0.84, 3.4, doorTile);
      plate.translate(0, COURSE.floorY + h * (i + 0.5), z + 1.7);
      shutter.push(plate);

      // The seam light under each plate.
      if (i > 0) {
        const seam = texturedBox(width * 0.98, h * 0.1, 1.2, TILE);
        seam.translate(0, COURSE.floorY + h * i, z + 2.6);
        bucket(lamps, PALETTE.runeEdge).push(seam);
      }
    }

    /*
     * The CENTRE SPLIT, because a shutter this size opens as two leaves.
     *
     * One dark channel down the middle with a lit strip either side of it. It
     * costs three boxes and it is the single detail that stops the door
     * reading as one slab of decoration.
     */
    /*
     * 4.0 DEEP, NOT 4.4, AND THAT IS THE WHOLE REASON THE DOOR IS CLEAN.
     *
     * At 4.4 its front face landed on z + 3.2 - the exact plane of the seam
     * light under every plate - so each of the seven seams crossed the split
     * with two same-facing surfaces on one plane and tore into the hatched
     * flicker a depth buffer produces when it cannot choose between them. The
     * door now has three distinct planes stepping backwards, which is also
     * what it should look like: the plate proud at z + 3.4, the seam light set
     * into the gap behind it at z + 3.2, and the split deeper still.
     */
    const channel = texturedBox(2.4, height, 4.0, TILE);
    channel.translate(0, COURSE.floorY + height / 2, z + 1);
    steel.push(channel);
    for (const side of [-1, 1]) {
      const edge = texturedBox(0.9, height - h * 0.4, 1.2, TILE);
      edge.translate(side * 1.9, COURSE.floorY + height / 2, z + 3);
      bucket(lamps, PALETTE.runeEdge).push(edge);
    }

    // The frame: two jambs and a lintel, standing proud of the shutter.
    for (const side of [-1, 1]) {
      const jamb = texturedBox(5, height + 8, 5, TILE);
      jamb.translate(side * (width / 2 + 2.5), COURSE.floorY + (height + 8) / 2, z + 1);
      steel.push(jamb);
      const strip = texturedBox(1.4, height, 1.4, TILE);
      strip.translate(side * (width / 2 + 2.5), COURSE.floorY + height / 2, z + 3.6);
      bucket(lamps, PALETTE.runeEdge).push(strip);
    }
    const lintel = texturedBox(width + 14, 6, 6, TILE);
    lintel.translate(0, COURSE.floorY + height + 3, z + 1);
    steel.push(lintel);
    const brow = texturedBox(width, 1.4, 1.4, TILE);
    brow.translate(0, COURSE.floorY + height + 6.4, z + 3.2);
    bucket(lamps, PALETTE.runeEdge).push(brow);
  }

  /**
   * SERVICE TOWERS behind the bulkheads.
   *
   * Lattice masts with a lit head, standing outside the corridor at a slow
   * pitch. Seen over the wall tops and through every doorway, they are what
   * tells the player the facility carries on past the room they are in - a
   * building with nothing outside it is a corridor, however long it is.
   */
  private buildScenery(): void {
    const masts: BufferGeometry[] = [];
    const heads: BufferGeometry[] = [];
    let index = 0;

    for (let z = COURSE.lobbyStartZ; z < COURSE_END_Z; z += SCENERY.treeSpacingZ) {
      for (const side of [-1, 1]) {
        index += 1;
        // Deterministic variation: a hash of the index, never Math.random, so
        // every client sees the same skyline.
        const wobble = ((index * 2654435761) >>> 0) / 4294967296;
        const halfWidth = corridorHalfWidthAt(z);
        const x = side * (halfWidth + SCENERY.treeOffsetX + wobble * 12);
        const at = z + wobble * SCENERY.treeSpacingZ * 0.6;
        this.pushTree(masts, heads, x, COURSE.floorY, at, 1 + wobble * 0.7);
      }
    }

    // In-world masts from the stage data, on the same two meshes.
    for (const decoration of DECORATIONS) {
      if (decoration.kind !== 'tree') continue;
      this.pushTree(
        masts,
        heads,
        decoration.x,
        decoration.y,
        decoration.z,
        decoration.scale,
      );
    }

    this.addMerged(masts, this.texturedMaterial(
      this.textures.stone(PALETTE.stone, PALETTE.stoneDark),
    ), false);
    this.addMerged(heads, this.emissiveMaterial(PALETTE.hedge, 0.8), false);
  }

  /**
   * One service tower: a tapering lattice with a lit beacon on top.
   *
   * Four boxes. The taper is the whole silhouette - a column of equal boxes
   * reads as a pipe, and a pipe with a light on it reads as nothing at all.
   */
  private pushTree(
    masts: BufferGeometry[],
    heads: BufferGeometry[],
    x: number,
    baseY: number,
    z: number,
    scale: number,
  ): void {
    const height = 34 * scale;
    const stages: readonly (readonly [number, number, number])[] = [
      [4.2, height * 0.45, 0],
      [3.0, height * 0.35, height * 0.45],
      [2.0, height * 0.2, height * 0.8],
    ];
    for (const [w, h, y] of stages) {
      const section = texturedBox(w * scale, h, w * scale, TILE);
      section.translate(x, baseY + y + h / 2 - COURSE.floorThickness, z);
      masts.push(section);
    }
    // Cross-arms near the top, so the mast has a silhouette against the dark.
    const arm = texturedBox(11 * scale, 1.1 * scale, 1.1 * scale, TILE);
    arm.translate(x, baseY + height * 0.78, z);
    masts.push(arm);

    const beacon = texturedBox(2.2 * scale, 2.2 * scale, 2.2 * scale, TILE);
    beacon.translate(x, baseY + height + 1.2, z);
    heads.push(beacon);
  }

  /**
   * Stage-specific scenery: the false floors of stage 4.
   *
   * They are drawn as tree canopy - leaves rather than planks - and have NO
   * solid behind them. That material difference is the entire tell, which is
   * what makes the stage a reading test rather than a guessing game.
   */
  private buildDecorations(): void {
    const leaves: BufferGeometry[] = [];

    for (const decoration of DECORATIONS) {
      if (decoration.kind !== 'falseFloor') continue;
      const size = 7 * decoration.scale;
      // Two stacked plates, so it has the silhouette of something to land on
      // when glanced at from a distance.
      const top = texturedBox(size, 0.7, size, TILE);
      top.translate(decoration.x, decoration.y, decoration.z);
      leaves.push(top);
      const under = texturedBox(size * 0.7, 0.6, size * 0.7, TILE);
      under.translate(decoration.x, decoration.y - 0.65, decoration.z);
      leaves.push(under);
    }

    this.addMerged(leaves, this.solidMaterial(PALETTE.canopyB), false);
    this.buildProps();
  }

  /**
   * The scenery of the later stages: boulders, waterfalls and torches.
   *
   * All of it is boxes, and all of it merges into one mesh per material - a
   * forest of fourteen trees and seven boulders is two draw calls, the same as
   * a forest of one.
   */
  private buildProps(): void {
    const rocks: BufferGeometry[] = [];
    const water: BufferGeometry[] = [];
    const posts: BufferGeometry[] = [];
    /*
     * Strip lights and beacons burn their SECTION's colour, the same as the
     * lamp columns on the walls around them - so a stage's light comes from
     * every source in it rather than from two that disagree.
     */
    const flames = new Map<number, BufferGeometry[]>();
    const iron: BufferGeometry[] = [];
    const crystals: BufferGeometry[] = [];

    for (const decoration of DECORATIONS) {
      const { x, y, z, scale } = decoration;

      if (decoration.kind === 'rock') {
        // Three offset boxes, so a boulder has a silhouette rather than being
        // a cube with a rock-coloured texture on it.
        const lumps = [
          { w: 5.5, h: 4, d: 5, dx: 0, dy: 2, dz: 0 },
          { w: 3.6, h: 2.6, d: 3.4, dx: 1.8, dy: 1.3, dz: -1.4 },
          { w: 2.8, h: 3.4, d: 3, dx: -1.6, dy: 1.7, dz: 1.2 },
        ];
        for (const lump of lumps) {
          const box = texturedBox(lump.w * scale, lump.h * scale, lump.d * scale, TILE);
          box.translate(x + lump.dx * scale, y + lump.dy * scale, z + lump.dz * scale);
          rocks.push(box);
        }
        continue;
      }

      if (decoration.kind === 'waterfall') {
        // A flat sheet down the wall, stepped so it reads as falling water
        // rather than as a painted stripe.
        for (let i = 0; i < 4; i += 1) {
          const box = texturedBox(1.2, 6 * scale, (9 - i) * scale, TILE);
          box.translate(x, y - i * 5.6 * scale, z);
          water.push(box);
        }
        continue;
      }

      if (decoration.kind === 'torch') {
        /*
         * A WALL STRIP LIGHT: a slim vertical bar in a shallow bracket.
         *
         * Vertical and NARROW, because that is what reads as architecture at
         * speed. The first version of these was a flame-sized box bolted to
         * the wall, which from the middle of the corridor looked like a row of
         * bright signs nobody had written anything on - the strip is the same
         * light in the shape the rest of the world is built out of.
         */
        const bracket = texturedBox(0.9 * scale, 6.5 * scale, 0.5 * scale, TILE);
        bracket.translate(x, y, z);
        iron.push(bracket);
        const bar = texturedBox(0.45 * scale, 5.6 * scale, 0.45 * scale, TILE);
        bar.translate(x - Math.sign(x) * 0.5 * scale, y, z);
        bucket(flames, accentForStage(decoration.stage)).push(bar);
        continue;
      }

      if (decoration.kind === 'brazier') {
        /*
         * A FLOOR BEACON: a dark bollard with a lit column inside it.
         *
         * The hangar's standing light, and the thing that marks every win pad
         * and lines the walk to the course entrance. Tall and thin rather than
         * a bowl of fire on legs: a wide bright box at head height reads as a
         * blank sign from every angle except directly above, which is the one
         * angle nobody in a third-person game ever has.
         */
        const base = texturedBox(1.8 * scale, 0.5 * scale, 1.8 * scale, TILE);
        base.translate(x, y + 0.25 * scale, z);
        iron.push(base);
        const column = texturedBox(1.1 * scale, 5.2 * scale, 1.1 * scale, TILE);
        column.translate(x, y + 3.1 * scale, z);
        iron.push(column);
        // The light itself, inset so the housing frames it on all four sides.
        const glow = texturedBox(0.62 * scale, 4.4 * scale, 1.24 * scale, TILE);
        glow.translate(x, y + 3.1 * scale, z);
        bucket(flames, accentForStage(decoration.stage)).push(glow);
        const cap = texturedBox(1.6 * scale, 0.4 * scale, 1.6 * scale, TILE);
        cap.translate(x, y + 5.9 * scale, z);
        iron.push(cap);
        continue;
      }

      if (decoration.kind === 'chain') {
        // Links from the ceiling down into the dark. Purely a vertical line
        // through the frame, and that is the job: a cavern with nothing
        // hanging in it has no sense of how high its roof is.
        for (let i = 0; i < 9; i += 1) {
          const link = texturedBox(
            (i % 2 === 0 ? 0.55 : 0.35) * scale,
            1.5 * scale,
            (i % 2 === 0 ? 0.35 : 0.55) * scale,
            TILE,
          );
          link.translate(x, y - i * 1.7 * scale, z);
          iron.push(link);
        }
        continue;
      }

      if (decoration.kind === 'crystal') {
        // A floating shard, stacked so it tapers to a point at both ends.
        const bands = [
          { w: 1.0, h: 1.6, dy: 0 },
          { w: 1.4, h: 1.4, dy: 1.5 },
          { w: 0.9, h: 1.8, dy: 2.9 },
          { w: 0.4, h: 1.2, dy: 4.2 },
        ];
        for (const band of bands) {
          const shard = texturedBox(
            band.w * scale,
            band.h * scale,
            band.w * scale,
            TILE,
          );
          shard.translate(x, y + band.dy * scale, z);
          crystals.push(shard);
        }
      }
    }

    this.addMerged(rocks, this.solidMaterial(PALETTE.rock), false);
    this.addMerged(posts, this.solidMaterial(PALETTE.trunk), false);
    this.addMerged(iron, this.solidMaterial(PALETTE.metalDark), false);

    if (crystals.length > 0) {
      // Lit, and the same violet the hard-light platforms are: in this world a glow is
      // always the machine, and a cell that glowed some other colour would be
      // the first thing to break that.
      const material = new MeshLambertMaterial({
        color: PALETTE.runeEdge,
        transparent: true,
        opacity: 0.85,
      });
      material.emissive.setHex(PALETTE.runeGlow);
      material.emissiveIntensity = 0.9;
      this.materials.push(material);
      this.addMerged(crystals, material, false);
    }

    if (water.length > 0) {
      const material = new MeshLambertMaterial({
        color: PALETTE.water,
        transparent: true,
        opacity: 0.78,
      });
      this.materials.push(material);
      this.addMerged(water, material, false);
    }
    for (const [color, parts] of flames) {
      this.addMerged(parts, this.emissiveMaterial(color, 0.9), false);
    }
  }

  /**
   * The floating label over each win pad, and the trophy above it.
   *
   * "+N WINS" on top and "RETURN" underneath. The order is the whole point:
   * the first line is what the player gets and the second is what happens
   * next, and the second is an honest promise rather than a surprise - banking
   * a stage sends the player straight back to the hangar, which is also what
   * makes a second payment impossible.
   *
   * The trophy is the SUPPLIED ART from `assets/ui/trophy.png`, the same image
   * the Wins counter and the award flight use, so the thing a player chases
   * across a stage and the thing that then appears on their HUD are plainly
   * one object.
   */
  private buildWinPadSigns(): void {
    for (const stage of STAGES) {
      const sign = new CanvasSign(16, 7, [
        {
          /*
           * GOLD, and the one heavy outline left in the world.
           *
           * Every other sign in this facility is set in a thin hairline,
           * because a poster face on architecture reads as a toy. This one is
           * not architecture - it is the payout, hanging in the air over the
           * plate, and the reference draws it as a fat gold headline with a
           * dark rim exactly so it carries across a stage. "Wins" is plural
           * whatever the figure is, as the art has it.
           *
           * Formatted, like every other large figure the player reads: the
           * late stages pay millions, and "+5000000" is a number nobody parses
           * at three hundred units a second.
           */
          text: `+${formatSpeed(stage.winReward)} Wins`,
          size: 1,
          fill: '#ffc51f',
          stroke: '#231502',
          strokeWidth: 0.17,
        },
        // Underneath, in white: what the pad DOES, as opposed to what it pays.
        { text: 'Return', size: 0.58, fill: '#ffffff', stroke: '#231502', strokeWidth: 0.15 },
      ]);
      sign.mesh.position.set(stage.winPadX, COURSE.floorY + 6.4, stage.winPadZ);
      // Facing back down the course, at the player arriving.
      sign.mesh.rotation.y = Math.PI;
      this.root.add(sign.mesh);
      this.winSigns.push(sign);

    }

    this.buildWinPadPlinths();
    this.buildWinPadHalos();
    this.buildWinPadCups();
  }

  /**
   * THE DARK PLINTH every trophy pad is set into.
   *
   * A slab a little larger than the pad and a little shallower, so what the
   * player sees is a gold plate INSET in a dark border - which is the single
   * thing that makes the reference pad read as an object placed on the deck
   * rather than as a gold rectangle painted onto it. The border also does the
   * job a drop shadow does in 2D: it separates the bright plate from whatever
   * colour the floor happens to be in that section.
   *
   * Thirty of them in ONE merged mesh, like the halos.
   */
  private buildWinPadPlinths(): void {
    const slabs: BufferGeometry[] = [];
    for (const stage of STAGES) {
      const slab = texturedBox(
        WIN_PAD.width + PLINTH.margin * 2,
        PLINTH.height,
        WIN_PAD.length + PLINTH.margin * 2,
        TILE,
      );
      // Sunk so its top sits just below the gold, leaving the plate proud.
      slab.translate(
        stage.winPadX,
        COURSE.floorY + PLINTH.height / 2 - 0.02,
        stage.winPadZ,
      );
      slabs.push(slab);
    }
    this.addMerged(slabs, this.solidMaterial(PALETTE.winPadRim), true);
  }

  /**
   * A pool of warm light lying over every win pad.
   *
   * One flat slab a little wider than the pad, sitting just above it, additive
   * and pulsing with the pad's own glow. It is what makes the gold read as
   * LIGHT COMING OFF the pad rather than as a gold texture: an emissive
   * material brightens its own pixels and stops there, and a reward should
   * spill onto the deck around it.
   *
   * Thirty of them MERGED into one mesh, so the whole course's worth of
   * celebration is a single draw call and a single opacity written per frame.
   */
  private buildWinPadHalos(): void {
    const slabs: BufferGeometry[] = [];
    for (const stage of STAGES) {
      const slab = texturedBox(WIN_PAD.width + 9, 0.12, WIN_PAD.length + 9, TILE);
      slab.translate(stage.winPadX, COURSE.floorY + WIN_PAD.height + 0.14, stage.winPadZ);
      slabs.push(slab);
    }

    const material = new MeshLambertMaterial({
      color: 0xffc94a,
      transparent: true,
      opacity: WIN_GLOW.haloBase,
      // Additive and depth-write off: this is light lying on the deck, and a
      // glow that occluded what is under it would be a gold rectangle.
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    material.emissive.setHex(0xffb01a);
    material.emissiveIntensity = 1;
    this.materials.push(material);
    this.winHaloMaterial = material;

    this.addMerged(slabs, material, false);
  }

  /**
   * THE LITTLE CUPS scattered on and around every pad.
   *
   * The reference win area has a handful of small trophies sitting on the
   * plate rather than one big one hanging over it, and that is the better
   * read: the prize is ON the thing you step onto, and the text above it is
   * what carries at distance.
   *
   * ALL NINETY IN ONE MESH. A cup is a quad with the supplied PNG on it, and
   * thirty pads' worth as separate billboards would be ninety draw calls for
   * decoration - so they are merged into a single geometry with one material,
   * facing back down the course like every other piece of world signage.
   *
   * The build waits for the image, because the aspect ratio is DRIVEN by the
   * art and never set: the quads cannot be sized until the file has decoded.
   */
  private buildWinPadCups(): void {
    const texture = loadSharedImage(TROPHY_URL);
    const build = (): void => {
      const image = texture.image as { width?: number; height?: number } | null;
      const width = image?.width ?? 0;
      const height = image?.height ?? 0;
      if (width <= 0 || height <= 0) return;

      const quads: BufferGeometry[] = [];
      for (const stage of STAGES) {
        for (const cup of CUPS) {
          const tall = CUP_HEIGHT * cup.scale;
          const quad = new PlaneGeometry(tall * (width / height), tall);
          // Facing back down the course, at the player arriving - the same way
          // the "+N Wins" sign over the pad faces.
          quad.rotateY(Math.PI);
          // The offsets are FRACTIONS of the plate's half-extent, so a pad
          // that is ever resized keeps its cups in the same relative places
          // instead of piling them in the middle.
          quad.translate(
            stage.winPadX + cup.x * (WIN_PAD.width / 2),
            COURSE.floorY + WIN_PAD.height + tall / 2 + cup.lift,
            stage.winPadZ + cup.z * (WIN_PAD.length / 2),
          );
          quads.push(quad);
        }
      }

      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        // Cut the transparent border out rather than blending it, exactly as
        // `ImageBillboard` does: a soft edge in front of a lit pad reads as a
        // grey rectangle around every cup.
        alphaTest: 0.5,
        side: DoubleSide,
        // Artwork, not a surface. Shading it would put the hall's own darkness
        // over a thing that is meant to read as gold.
        fog: false,
      });
      this.materials.push(material);

      const merged = mergeGeometries(quads, false);
      for (const quad of quads) quad.dispose();
      if (!merged) return;
      this.cupMesh = new Mesh(merged, material);
      this.root.add(this.cupMesh);
    };

    const image = texture.image as { width?: number } | null;
    if (image?.width) build();
    else onImageDecoded(texture, build);
  }

  /**
   * The idle pulse: a slow breath across every win pad in the course.
   *
   * SUBTLE on purpose - a pad that flashed would compete with the hazards,
   * which are the things in this game allowed to demand attention. Two sine
   * evaluations and two property writes per frame, whatever the player is
   * doing and however many pads exist.
   */
  private pulseWinPads(delta: number): void {
    this.glowTime += delta;
    const breath = (Math.sin(this.glowTime * WIN_GLOW.rate) + 1) / 2;

    if (this.winPadMaterial) {
      this.winPadMaterial.emissiveIntensity = WIN_GLOW.base + breath * WIN_GLOW.swing;
    }
    if (this.winHaloMaterial) {
      this.winHaloMaterial.opacity = WIN_GLOW.haloBase + breath * WIN_GLOW.haloSwing;
    }

    /*
     * The cups ride the same breath, and it is ONE transform for all ninety.
     *
     * They are a single merged mesh, so lifting them is one write - and they
     * bob to the SAME clock as the glow, which is what makes the pad and the
     * prizes sitting on it read as one object rather than as two effects that
     * happen to be near each other.
     */
    if (this.cupMesh) {
      this.cupMesh.position.y = Math.sin(this.glowTime * WIN_GLOW.rate) * 0.35;
    }
  }

  private addMerged(
    geometries: BufferGeometry[],
    material: Material,
    receiveShadow: boolean,
  ): void {
    if (geometries.length === 0) return;
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) return;
    const mesh = new Mesh(merged, material);
    mesh.receiveShadow = receiveShadow;
    this.root.add(mesh);
  }

  /** One material per kind, built once and remembered for disposal. */
  private materialFor(kind: SolidKind): Material {
    switch (kind) {
      case 'floor':
        return this.texturedMaterial(
          this.textures.grassStuds(PALETTE.grass, PALETTE.grassStud),
        );
      case 'lobby':
        return this.texturedMaterial(
          this.textures.grassStuds(PALETTE.lobbyGrass, PALETTE.lobbyGrassStud),
        );
      case 'training':
        return this.texturedMaterial(
          this.textures.planks(PALETTE.deck, PALETTE.deckDark, PALETTE.woodSpeck),
        );
      case 'block':
      case 'plank':
        return this.texturedMaterial(
          this.textures.planks(PALETTE.wood, PALETTE.woodDark, PALETTE.woodSpeck),
        );
      case 'ruin':
        return this.texturedMaterial(
          this.textures.stone(hex(PALETTE.ruin), hex(PALETTE.ruinDark)),
        );
      case 'ice':
        return this.texturedMaterial(this.textures.ice(PALETTE.ice, PALETTE.iceStud));
      case 'stone':
        return this.texturedMaterial(this.textures.stone(PALETTE.stone, PALETTE.stoneDark));
      case 'log':
        return this.texturedMaterial(
          this.textures.planks(PALETTE.log, PALETTE.logDark, PALETTE.woodSpeck),
        );
      case 'metal':
        return this.texturedMaterial(
          this.textures.stone(hex(PALETTE.metal), hex(PALETTE.metalDark)),
        );
      case 'pillar':
        return this.brickMaterial();
      case 'ceiling':
        // The same masonry as the walls, so the room closes rather than being
        // capped with something that reads as a different building.
        return this.brickMaterial();
      case 'rune': {
        /*
         * THE hard-light platform, and the one structural material in the
         * world that emits.
         *
         * It has to: a hard-light slab hangs over a lava channel or a void
         * with nothing under it, and in a hall this dark an unlit slab is a
         * silhouette the player cannot judge the edge of. Lighting it also
         * makes the promise the whole course is built on legible at distance -
         * CYAN means "somewhere to land" - so the route through a stage is
         * readable from the platform before it.
         */
        const material = new MeshLambertMaterial({
          map: this.textures.runeSlab(hex(PALETTE.rune), hex(PALETTE.runeEdge)),
        });
        material.emissive.setHex(PALETTE.runeGlow);
        material.emissiveIntensity = 0.55;
        this.materials.push(material);
        return material;
      }
      case 'winPad': {
        /*
         * THE TROPHY PAD, and it BURNS.
         *
         * The one surface in the game that is a reward rather than a route, so
         * it is lit warmer and harder than anything else: a gold slab glowing
         * at the end of a stage is the thing a player is hunting for through
         * the whole of it. `pulseWinPads` then breathes this intensity so the
         * pad reads as ACTIVE rather than merely painted - the difference
         * between a prize and a doormat.
         */
        const material = new MeshLambertMaterial({
          map: this.textures.winPlate(PALETTE.winPad, PALETTE.winPadAlt),
        });
        material.emissive.setHex(0xffb01a);
        material.emissiveIntensity = WIN_GLOW.base;
        this.materials.push(material);
        this.winPadMaterial = material;
        return material;
      }
      case 'returnPad': {
        /*
         * The RETURN pad, and it is deliberately NOT gold.
         *
         * It sits opposite the win pad at the same size and the same height,
         * so the only thing telling them apart is colour - and it has to be
         * the one colour in this game that never means a reward. Cyan is the
         * game's "safe route" colour; a second gold rectangle at the end of
         * every stage would have players hunting for which one pays.
         */
        const material = new MeshLambertMaterial({
          map: this.textures.goldCheck(PALETTE.returnPad, PALETTE.returnPadAlt),
        });
        material.emissive.setHex(PALETTE.runeGlow);
        material.emissiveIntensity = 0.35;
        this.materials.push(material);
        return material;
      }
      case 'stand':
      default:
        return this.solidMaterial(PALETTE.standBase);
    }
  }

  private brickMaterial(): Material {
    return this.texturedMaterial(
      this.textures.brick(PALETTE.wall, PALETTE.wallDark, PALETTE.wallSpeck),
    );
  }

  private texturedMaterial(map: Texture): Material {
    const material = new MeshLambertMaterial({ map });
    this.materials.push(material);
    return material;
  }

  /**
   * A lit material, for anything the facility powers.
   *
   * One helper because this building has a LOT of them: every lamp column,
   * every rail, every ceiling panel and every wash on the deck. Lambert with
   * emissive rather than a shader - the art is flat, and the glow is a
   * brightness rather than a bloom.
   */
  private emissiveMaterial(color: number, intensity: number): Material {
    const material = new MeshLambertMaterial({ color });
    material.emissive.setHex(color);
    material.emissiveIntensity = intensity;
    this.materials.push(material);
    return material;
  }

  private solidMaterial(color: number): Material {
    const material = new MeshLambertMaterial({ color });
    this.materials.push(material);
    return material;
  }
}

/** A solid's box, positioned in world space. */
const boxFor = (solid: CourseSolid, tile: number): BufferGeometry => {
  const geometry = texturedBox(
    solid.maxX - solid.minX,
    solid.maxY - solid.minY,
    solid.maxZ - solid.minZ,
    tile,
  );
  geometry.translate(
    (solid.minX + solid.maxX) / 2,
    (solid.minY + solid.maxY) / 2,
    (solid.minZ + solid.maxZ) / 2,
  );
  return geometry;
};

const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

export { STAGES, TRAINING };
