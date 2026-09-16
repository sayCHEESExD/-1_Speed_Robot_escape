import {
  DISPLAYED_ROBOTS,
  ROBOTS,
  STAND_ROW,
  formatSpeed,
  standDeckY,
  standX,
  standZ,
} from '@robot/shared';
import {
  Group,
  Mesh,
  MeshLambertMaterial,
  PointLight,
  type BufferGeometry,
} from 'three';
import { RobotModel } from '../robot/RobotModel.js';
import { PALETTE } from '../config/worldVisuals.js';
import { CanvasSign } from './CanvasSign.js';
import { texturedBox } from './texturedBox.js';

/** One bay: the mech in it, its data panel, its cradle and its floor ring. */
interface Stand {
  readonly slot: number;
  readonly model: RobotModel;
  readonly sign: CanvasSign;
  readonly top: Mesh;
  readonly halo: Mesh;
  readonly frame: Mesh[];
}

/**
 * THE MECH BAYS, down the LEFT wall of the hangar.
 *
 * Not a shop with the items standing in a row: a maintenance deck with ten
 * machines DOCKED IN IT. Each bay is a recessed alcove in the bulkhead with
 * its own gantry frame, its own overhead service arm, a lit floor ring and a
 * data panel on the wall beside it - which is what the reference facility
 * does, and what stops the row reading as a shelf.
 *
 * The purchase is still a PLACE rather than a menu: the player walks their own
 * machine onto the cradle and the server decides whether they can afford the
 * one docked there. Reaching the Wins total alone does nothing.
 *
 * TWO LEVELS OF FIVE, stepped back like a service gallery - the lower row at
 * deck height, the upper row on a gantry fifteen units up and further out,
 * with a stairway at each end. Stepped rather than stacked for two reasons
 * that both matter: a balcony directly over the lower row would put its
 * underside through the shoulder blocks of every mech docked beneath it, and a
 * row under an overhang is a row nobody standing in the middle of the hangar
 * can see.
 *
 * EVERY MACHINE FACES THE ROOM AND STAYS FACING IT. They are parked, square
 * to the deck, looking at the player who walked in - not turning on
 * turntables. The sweep this used to run was the single thing stopping the
 * gallery reading as a line-up: half the deck was always showing a shoulder,
 * and a mech seen three-quarters-on is a mech whose silhouette you cannot
 * compare with the one beside it.
 *
 * WHAT IS NOT HERE MATTERS AS MUCH. No service arm reaching in over the
 * shoulder, no clutter in front of the cradle: the bay is a frame, a pad, a
 * light and a nameplate, and everything else in the volume a player looks
 * through is left empty so the machine is the only thing in it.
 *
 * Slots 11 and 12 have no bay. The deck is five and five, and the two
 * prototype frames are requisitioned from the mech panel on the HUD rail - the
 * same purchase, through the same server authority, by the only route that
 * does not break the layout.
 */
export class RobotStands {
  readonly root = new Group();

  private readonly stands: Stand[] = [];
  private readonly signs: CanvasSign[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly lamps: PointLight[] = [];
  private readonly materials: MeshLambertMaterial[] = [];

  private readonly cradleMaterial: MeshLambertMaterial;
  private readonly steelMaterial: MeshLambertMaterial;
  private readonly ownedMaterial: MeshLambertMaterial;
  private readonly lockedMaterial: MeshLambertMaterial;
  private readonly haloOwned: MeshLambertMaterial;
  private readonly haloLocked: MeshLambertMaterial;
  private readonly frameOwned: MeshLambertMaterial;
  private readonly frameLocked: MeshLambertMaterial;

  private time = 0;

  constructor() {
    this.cradleMaterial = this.material(PALETTE.standBase);
    this.steelMaterial = this.material(PALETTE.metal);
    this.ownedMaterial = this.lit(PALETTE.standTop, 0.9);
    this.lockedMaterial = this.material(PALETTE.standLocked);
    this.haloOwned = this.lit(PALETTE.standHalo, 1.1);
    this.haloLocked = this.lit(PALETTE.standHaloLocked, 0.25);
    // The gantry frame around each alcove: lit when the machine in it is
    // yours, dead when it is not. It is the single fastest read of "which of
    // these ten is mine" from the far end of a ninety-unit hangar.
    this.frameOwned = this.lit(PALETTE.runeEdge, 0.85);
    this.frameLocked = this.material(PALETTE.metalDark);

    const W = STAND_ROW.width;
    const L = STAND_ROW.length;

    const cradle = this.geometry(W, STAND_ROW.height, L);
    const ring = this.geometry(W * 1.35, 0.14, L * 1.35);
    const cap = this.geometry(W * 0.8, 0.22, L * 0.8);
    const post = this.geometry(1.4, 17.8, 1.4);
    const header = this.geometry(W * 1.5, 1.6, 2.0);
    const backPlate = this.geometry(1.6, 18, L * 1.5);
    /* The nameplate's own board, so the text is on something. */
    const plate = this.geometry(0.6, 4.6, 16);
    const plateEdge = this.geometry(0.7, 0.4, 16.6);

    for (const robot of ROBOTS) {
      // Only the first ten have a bay. `DISPLAYED_ROBOTS` is derived from the
      // deck's own size rather than written as a 10 here, so a third level
      // would need no edit.
      if (robot.slot > DISPLAYED_ROBOTS) break;

      const upper = robot.slot > STAND_ROW.perDeck;
      const group = new Group();
      group.position.set(standX(robot.slot), standDeckY(robot.slot), standZ(robot.slot));

      // The alcove's back plate, hard against the bulkhead behind the bay.
      group.add(this.mesh(backPlate, this.steelMaterial, W * 0.95, 9, 0));

      const base = this.mesh(cradle, this.cradleMaterial, 0, STAND_ROW.height / 2, 0);
      base.receiveShadow = true;
      group.add(base);

      const top = this.mesh(cap, this.lockedMaterial, 0, STAND_ROW.height + 0.11, 0);
      group.add(top);

      const halo = this.mesh(ring, this.haloLocked, 0, 0.07, 0);
      group.add(halo);

      /*
       * THE GANTRY FRAME: two posts and a header over the alcove.
       *
       * It is the thing that makes a bay a bay. A mech standing on a plinth in
       * the open is an ornament; the same mech standing under a frame with a
       * service arm reaching into it is a machine somebody parked.
       */
      const frame: Mesh[] = [];
      for (const side of [-1, 1]) {
        frame.push(this.mesh(post, this.frameLocked, 0, 8.9, side * (L * 0.62)));
      }
      frame.push(this.mesh(header, this.frameLocked, 0, 17, 0));
      for (const piece of frame) group.add(piece);

      const model = new RobotModel(robot);
      model.setDisplayLit(true);
      model.root.position.y = STAND_ROW.height + 0.22;
      /*
       * Facing -X, square to the deck, and it never changes.
       *
       * The bays are against the +X bulkhead, so -X is the room - which is
       * where the player is, on either storey. Set once here and never touched
       * again: `update` deliberately does not rotate these.
       */
      model.root.rotation.y = -Math.PI / 2;
      group.add(model.root);

      /*
       * THE DATA PANEL: three lines, on the bay's own header.
       *
       * A designation, the output rating and the price. It reads as equipment
       * documentation rather than as a price tag, which is the difference
       * between a facility and a market stall - and the rating is the number
       * the whole ladder is, so it is the big one.
       */
      /*
       * THE NAMEPLATE, on the bay's own board at chest height for a reader on
       * the deck - not floating over the machine's head.
       *
       * Sixteen units of text in a bay every twenty-four: two neighbours can
       * never run into one another, and the two storeys carry theirs at
       * different heights relative to their own deck, so a lower plate and the
       * plate above it never line up in the same part of the screen either.
       * Overlapping labels were most of why the gallery read as a mess.
       */
      group.add(this.mesh(plate, this.steelMaterial, W * 0.62, 12.6, 0));
      for (const dy of [-1, 1]) {
        group.add(
          this.mesh(plateEdge, this.frameOwned, W * 0.62 - 0.1, 12.6 + dy * 2.5, 0),
        );
      }

      const sign = new CanvasSign(15, 4.2, [
        {
          text: robot.name.toUpperCase(),
          size: 0.62,
          fill: '#d8ff3a',
          stroke: '#101a02',
        },
        {
          /*
           * The rate and the price on ONE line.
           *
           * Ten bays are in view at once from the middle of the hangar, and
           * ten three-line placards is a wall of text with machines somewhere
           * behind it. Two lines is a designation and a spec, which is what a
           * showroom card is.
           */
          text:
            robot.winsRequired === 0
              ? `+${formatSpeed(robot.speedPerSecond)} SPEED/S · ISSUED`
              : `+${formatSpeed(robot.speedPerSecond)} SPEED/S · ${formatSpeed(
                  robot.winsRequired,
                )} WINS`,
          size: 0.72,
          fill: '#ffffff',
          stroke: '#050a12',
        },
      ]);
      sign.mesh.position.set(W * 0.62 - 0.35, 12.9, 0);
      sign.mesh.rotation.y = -Math.PI / 2;
      group.add(sign.mesh);

      this.root.add(group);
      this.stands.push({ slot: robot.slot, model, sign, top, halo, frame });
    }

    /*
     * TWO lamps, one over each level, and only two.
     *
     * A light per bay would be ten more lights in every Lambert shader in the
     * scene - the cost is paid by every fragment in the world, not by the ten
     * meshes that wanted it. One per gallery, hung over the middle of it with
     * a distance that dies before it reaches the open deck, lifts the bays out
     * of the dark and leaves the rest of the hangar as dark as it should be.
     *
     * The intensity looks absurd and is not: three.js uses physically correct
     * lighting, so what reaches a surface is `intensity / distance^2`, and a
     * "reasonable-looking" 1.5 thirty units up arrives as nothing at all.
     */
    const span = (STAND_ROW.perDeck - 1) * STAND_ROW.spacingZ;
    const midZ = standZ(1) + span / 2;
    for (const [x, y] of [
      [STAND_ROW.x, STAND_ROW.lowerY],
      [STAND_ROW.upperX, STAND_ROW.upperY],
    ] as const) {
      // Two per storey rather than one, at the quarter points: a single lamp
      // over a hundred-unit row leaves the machines at each end of it darker
      // than the ones in the middle, and a showroom lights every item alike.
      for (const at of [midZ - span * 0.28, midZ + span * 0.28]) {
        const lamp = new PointLight(0xe8f4ff, 3600, 150, 2);
        lamp.position.set(x - 9, y + 26, at);
        this.root.add(lamp);
        this.lamps.push(lamp);
      }
    }

    /*
     * The gallery's designation, hung high ABOVE the upper bays.
     *
     * IN FRONT OF THE WALL, not on it. The bulkhead carries a lit lamp column
     * every fifty-two units and a steel housing around each one, and a sign
     * flat against that wall has one of them standing across it from most of
     * the hangar - which is exactly how "MECH BAY" came to read as "M CH BAY"
     * and "FRAME STORAGE" as "ME STORAGE". Hanging it out over the gallery
     * puts every one of those columns behind it instead, and there is nothing
     * else at this height for it to meet.
     */
    const title = new CanvasSign(54, 11, [
      { text: 'MECH BAY', size: 1, fill: '#ffffff', stroke: '#101a02', strokeWidth: 0.08 },
      { text: 'FRAME STORAGE / ISSUE', size: 0.32, fill: '#d8ff3a', stroke: '#101a02' },
    ]);
    title.mesh.position.set(STAND_ROW.upperMinX + 3, STAND_ROW.upperY + 30, midZ);
    title.mesh.rotation.y = -Math.PI / 2;
    this.root.add(title.mesh);
    this.signs.push(title);
  }

  /**
   * Light the bays the player already owns.
   *
   * Reads the REPLICATED mask and nothing else - the client never decides what
   * a player owns, it only shows what the server says.
   */
  setOwned(ownedMask: number): void {
    for (const stand of this.stands) {
      const owned = (ownedMask & (1 << (stand.slot - 1))) !== 0;
      stand.top.material = owned ? this.ownedMaterial : this.lockedMaterial;
      stand.halo.material = owned ? this.haloOwned : this.haloLocked;
      for (const piece of stand.frame) {
        piece.material = owned ? this.frameOwned : this.frameLocked;
      }
      stand.model.setGlow(owned ? 1 : 0.1);
    }
  }

  /**
   * The deck's only motion, and it is the floor rings.
   *
   * THE MACHINES DO NOT MOVE. They are parked, facing the room, and a player
   * comparing two silhouettes has to be able to do it without waiting for
   * either of them to turn back. The rings breathe so the gallery is not
   * completely static; everything above them is a statue on purpose.
   */
  update(delta: number): void {
    this.time += delta;
    for (let i = 0; i < this.stands.length; i += 1) {
      const stand = this.stands[i];
      if (!stand) continue;
      stand.halo.scale.setScalar(1 + Math.sin((this.time + i * 0.7) * 1.4) * 0.03);
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
    return node;
  }

  private geometry(w: number, h: number, d: number): BufferGeometry {
    const geometry = texturedBox(w, h, d, 4);
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
    for (const stand of this.stands) {
      stand.model.dispose();
      stand.sign.dispose();
    }
    for (const sign of this.signs) sign.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const lamp of this.lamps) lamp.removeFromParent();
    this.stands.length = 0;
    this.signs.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.lamps.length = 0;
    this.root.removeFromParent();
  }
}
