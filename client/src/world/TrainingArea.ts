import {
  COURSE,
  TRAINING,
  TREADMILL_BELT_Y,
  TREADMILL_COUNT,
  treadmillX,
  treadmillZ,
} from '@robot/shared';
import {
  Group,
  Mesh,
  MeshLambertMaterial,
  type BufferGeometry,
  type Texture,
} from 'three';
import { PALETTE } from '../config/worldVisuals.js';
import { CanvasSign } from './CanvasSign.js';
import { texturedBox } from './texturedBox.js';

/** How fast the tread texture scrolls, in texture repeats per second. */
const BELT_SCROLL = 1.1;

/**
 * THE CALIBRATION BAY on the RIGHT of the hangar.
 *
 * Three heavy MECH TEST RIGS: a sunken tread the machine walks on, a steel
 * cradle around it, two hydraulic restraint arms that reach up either side of
 * its hips, and an instrument mast at the front carrying a lit readout. They
 * are industrial movement simulators, which is the only thing a treadmill
 * could sensibly be in a building where the smallest thing that walks is nine
 * units tall.
 *
 * THREE IDENTICAL RIGS, and identical is the whole point. There is no tier, no
 * level gate and no multiplier: a rig pays exactly what walking the same
 * ground pays, because the shared config hands both the same rate through the
 * same formula. The bay is somewhere to farm while chatting, not a ladder, so
 * there is nothing to choose between the three and no reason to queue.
 *
 * ORIENTATION: a rig faces the way the machine on it does, and that machine is
 * meant to be looking back at the spawn point in the middle of the hangar -
 * which from this deck against the right bulkhead is +X. So the tread runs
 * along X with the instrument mast at its +X end, and the rigs step along Z.
 *
 * The treads themselves are real solids in the shared course data; everything
 * here is the machine around them.
 */
export class TrainingArea {
  readonly root = new Group();

  private readonly belts: Mesh[] = [];
  private readonly signs: CanvasSign[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: MeshLambertMaterial[] = [];

  private time = 0;

  constructor(beltTexture: Texture) {
    const steel = this.material(PALETTE.metal);
    const steelDark = this.material(PALETTE.metalDark);
    const lit = this.lit(PALETTE.treadmillFrame, 0.9);
    /*
     * The readout is a SCREEN, which means dark glass inside a lit bezel.
     *
     * A slab of full-brightness cyan is not a display, it is a light - and
     * three of them across the bay were the brightest objects in the hangar
     * while carrying no information at all. The frame is what glows; the glass
     * only catches it, exactly like every other panel in the facility.
     */
    const screen = this.lit(PALETTE.boardFace, 0.25);
    const bezel = this.lit(PALETTE.treadmillScreenLit, 1.2);

    /*
     * The tread carries a scrolling chevron texture, which is what makes an
     * empty rig still read as running.
     *
     * WHITE, not the tread colour: a lit material MULTIPLIES its colour by its
     * map, so tinting an already-dark texture by its own dark colour crushes
     * the chevrons to black. The colours live in the texture; the material
     * just carries it, with a little emissive so they stay legible in the
     * cradle's own shadow.
     */
    const beltMaterial = this.material(0xffffff);
    beltMaterial.map = beltTexture;
    beltMaterial.emissive.setHex(0xffffff);
    beltMaterial.emissiveIntensity = 0.45;
    beltMaterial.emissiveMap = beltTexture;

    // Shared geometry: three rigs are three transforms of the same dozen
    // boxes, not three sets of geometry.
    const L = TRAINING.beltLength;
    const W = TRAINING.beltWidth;

    const cradle = this.geometry(L + 4, 2.2, W + 4);
    const tread = this.geometry(L - 2, 0.5, W - 4);
    const rail = this.geometry(L + 4, 1.6, 2.2);
    const roller = this.geometry(2.6, 2.4, W + 4);
    const armPost = this.geometry(2.0, 11, 2.0);
    const armPad = this.geometry(3.6, 2.4, 2.4);
    const mast = this.geometry(2.4, 13, W - 2);
    const face = this.geometry(0.5, 5.5, W - 6);
    const bezelH = this.geometry(0.62, 0.5, W - 5.2);
    const bezelV = this.geometry(0.62, 6.3, 0.5);
    const strip = this.geometry(0.5, 0.6, W - 2);

    for (let index = 1; index <= TREADMILL_COUNT; index += 1) {
      const rig = new Group();
      // No rotation: the tread geometry is authored running along X, which is
      // already the direction the machine on it faces.
      rig.position.set(treadmillX(index), TREADMILL_BELT_Y, treadmillZ(index));

      // The cradle the tread is sunk into.
      rig.add(this.mesh(cradle, steel, 0, -1.4, 0));

      // The running tread: dark, lit, and scrolling.
      const surface = this.mesh(tread, beltMaterial, 0, -0.1, 0);
      rig.add(surface);
      this.belts.push(surface);

      // Raised kerbs either side of the tread, with a lit line down each.
      for (const side of [-1, 1]) {
        rig.add(this.mesh(rail, steelDark, 0, 0.55, side * (W / 2 + 0.4)));
        rig.add(this.mesh(strip, lit, 0, 1.4, side * (W / 2 + 0.4)));
      }

      // The drive roller at the BACK - the end a machine steps on from.
      rig.add(this.mesh(roller, steelDark, -(L / 2 + 1.2), 0.1, 0));

      /*
       * THE RESTRAINT ARMS, and they are what makes the rig read as equipment
       * rather than as a rug.
       *
       * Two hydraulic posts standing at the sides, level with the hips of the
       * machine that will stand between them, each capped with a pad that
       * would bear against it. Nothing in the simulation knows they exist;
       * they are there so the shape says what the thing is from a distance.
       */
      for (const side of [-1, 1]) {
        rig.add(this.mesh(armPost, steel, 0, 5.5, side * (W / 2 + 2.6)));
        rig.add(this.mesh(armPad, lit, 0, 10.4, side * (W / 2 + 1.4)));
      }

      // The instrument mast at the FRONT, with a lit readout in it.
      rig.add(this.mesh(mast, steel, L / 2 + 1.4, 6.5, 0));
      rig.add(this.mesh(face, screen, L / 2 + 2.7, 7.5, 0));
      for (const dy of [-1, 1]) {
        rig.add(this.mesh(bezelH, bezel, L / 2 + 2.74, 7.5 + dy * 2.9, 0));
      }
      for (const dz of [-1, 1]) {
        rig.add(this.mesh(bezelV, bezel, L / 2 + 2.74, 7.5, dz * (W - 5.2) / 2));
      }

      this.root.add(rig);
    }

    this.buildSignage();
  }

  /**
   * THE BAY'S SIGNAGE: a lit display over the rigs and a caption under it.
   *
   * A DISPLAY, not a painted board. The first version of this was an amber
   * plate with outlined cartoon lettering, which read as a fairground stall
   * bolted to the wall of a mech facility - the one object in the hangar that
   * could not have been built by the people who built everything else in it.
   * This is the same information as a backlit sign: dark glass, a lit bezel,
   * cyan type, and the designation of the rigs underneath.
   *
   * Everything faces +X, back toward the open deck the players gather on.
   * Signs are single-sided, so one left facing +Z is invisible from the only
   * direction anybody ever approaches from.
   */
  private buildSignage(): void {
    const midZ = (TRAINING.minZ + TRAINING.maxZ) / 2;
    /*
     * The signage stands PROUD OF THE BULKHEAD, not flat against it.
     *
     * The wall carries a lit lamp column every fifty-two units and each one is
     * a couple of units thick, so a sign hung on the wall plane has a lamp
     * poking through it - which is how "DRIVE CALIBRATION" came to read as
     * "DRIVE CALIBRATI N". Three units into the room clears every one of them
     * and costs nothing: the board is forty-six units up with nothing else
     * near it.
     */
    const x = TRAINING.minX + 2.4;

    const boardWidth = 58;
    const boardHeight = 19;
    const depth = 2.2;
    const boardY = COURSE.floorY + 46;

    const face = this.lit(PALETTE.boardFace, 0.22);
    const surround = this.lit(PALETTE.runeEdge, 1.15);
    const steel = this.material(PALETTE.metal);

    const group = new Group();
    group.position.set(x, boardY, midZ);

    group.add(this.mesh(this.geometry(depth, boardHeight, boardWidth), face, 0, 0, 0));
    const barH = this.geometry(depth + 0.8, 2.4, boardWidth + 5);
    const barV = this.geometry(depth + 0.8, boardHeight + 5, 2.4);
    for (const dy of [-1, 1]) {
      group.add(this.mesh(barH, surround, 0, (dy * (boardHeight + 2.4)) / 2, 0));
    }
    for (const dz of [-1, 1]) {
      group.add(this.mesh(barV, surround, 0, 0, (dz * (boardWidth + 2.4)) / 2));
    }
    // Two mounting brackets back to the bulkhead, so the board is bolted to
    // something rather than floating in front of it.
    for (const dz of [-1, 1]) {
      group.add(
        this.mesh(this.geometry(6, 2.4, 2.4), steel, -3.5, 0, dz * boardWidth * 0.3),
      );
    }

    const word = new CanvasSign(boardWidth - 3, boardHeight - 3, [
      // The word the player is looking for, and the designation a technician
      // would look for. Both, because the bay has to be findable AND belong to
      // the building.
      { text: 'TREADMILLS', size: 1, fill: '#5df2ff', stroke: '#031c26', strokeWidth: 0.08 },
      {
        text: 'CALIBRATION DECK 01-03',
        size: 0.34,
        fill: '#d8ff3a',
        stroke: '#101a02',
        strokeWidth: 0.08,
      },
    ]);
    // Just proud of the panel, so it cannot z-fight with the face behind it.
    word.mesh.position.set(depth / 2 + 0.08, 0, 0);
    word.mesh.rotation.y = Math.PI / 2;
    group.add(word.mesh);
    this.signs.push(word);

    this.root.add(group);

    const caption = new CanvasSign(56, 13, [
      {
        text: 'DRIVE CALIBRATION',
        size: 1,
        fill: '#ffffff',
        stroke: '#050a12',
        strokeWidth: 0.08,
      },
      {
        // What the rig actually pays, stated as the plant would state it: a
        // belt is exactly walking, and there is no multiplier anywhere on it.
        text: 'OUTPUT EQUALS WALKING · NO MULTIPLIER',
        size: 0.36,
        fill: '#d8ff3a',
        stroke: '#101a02',
        strokeWidth: 0.08,
      },
    ]);
    caption.mesh.position.set(x, boardY - boardHeight / 2 - 11, midZ);
    caption.mesh.rotation.y = Math.PI / 2;
    this.root.add(caption.mesh);
    this.signs.push(caption);

    /*
     * NO LAMP COLUMNS IN FRONT OF THE BOARD.
     *
     * There were two, one at each end of the bay, and they stood between the
     * player and the signage: a fifty-unit lit vertical crossing "DRIVE
     * CALIBRATION" so the caption read as "DRIVE CALIBRATI N". A light that
     * obscures the only text in the bay is worse than no light, and the room
     * is lit well enough now to need neither - the fill rig, the board's own
     * lit bezel and the rig instrument screens all do that job without
     * standing in the way of a word.
     *
     * If this bay ever wants a lamp again it belongs BEHIND the board or
     * outboard of the rigs, never on the line between the board and the deck
     * the player reads it from.
     */
  }

  /**
   * Nothing to unlock, so nothing to do.
   *
   * Kept as a no-op rather than deleted because the caller is the same code
   * that lights the mech bays from replicated state, and a hangar feature that
   * silently stopped being told the player's level is a trap for the next
   * person who gives a rig something to gate on.
   */
  setLevel(_level: number): void {
    /* every rig is open to everybody, always */
  }

  /** Scroll the treads, so a rig standing empty still looks like it runs. */
  update(delta: number): void {
    this.time += delta;
    for (const belt of this.belts) {
      const material = belt.material as MeshLambertMaterial;
      if (!material.map) continue;
      // Along U, which is the tread's own length - the surface travels
      // BACKWARD under a machine facing +X.
      material.map.offset.x = (this.time * BELT_SCROLL) % 1;
    }
  }

  private mesh(
    geometry: BufferGeometry,
    material: MeshLambertMaterial,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const node = new Mesh(geometry, material);
    node.position.set(x, y, z);
    node.castShadow = true;
    node.receiveShadow = true;
    return node;
  }

  private geometry(w: number, h: number, d: number): BufferGeometry {
    const geometry = texturedBox(w, h, d, 3);
    this.geometries.push(geometry);
    return geometry;
  }

  private material(color: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color });
    this.materials.push(material);
    return material;
  }

  private lit(color: number, intensity: number): MeshLambertMaterial {
    const material = this.material(color);
    material.emissive.setHex(color);
    material.emissiveIntensity = intensity;
    return material;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const sign of this.signs) sign.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.signs.length = 0;
    this.belts.length = 0;
    this.root.removeFromParent();
  }
}
