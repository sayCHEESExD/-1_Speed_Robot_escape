import {
  Group,
  Sprite,
  SpriteMaterial,
  type Vector3,
} from 'three';
import { loadSharedImage } from './ImageBillboard.js';

/** The supplied trophy art. The same file the win pads and the HUD hang. */
const TROPHY_URL = '/ui/trophy.png';

/**
 * Cups in the pool, and the most any one award can put in the air.
 *
 * Allocated once and reused for ever: winning is rare but a long session wins
 * many times, and an effect that allocated per award would leave a growing
 * pile of dead sprites in the scene graph.
 */
const POOL = 12;

/** Fewest cups an award throws, however small the payout. */
const FEWEST = 4;

/**
 * THE THREE BEATS, in seconds.
 *
 * Out, hang, in. The throw is quick and the collection is slower, which is
 * what makes the cups read as thrown clear and then GATHERED; the other way
 * round reads as a vacuum cleaner. Cups are offset from each other by
 * `STAGGER`, so a handful arrives as a ripple rather than as one movement.
 *
 * The HANG is long on purpose - over half a second of trophies simply hanging
 * in the air at full size and full opacity. An award is a rare moment and the
 * player has to be able to SEE what they were given; a burst that threw and
 * collected in a third of a second was a gold flicker.
 */
const BURST = 0.34;
const HANG = 0.55;
const COLLECT = 0.6;
const STAGGER = 0.045;

/** Seconds one cup's whole performance lasts. */
const LIFE = BURST + HANG + COLLECT;

/** How far out and how high the throw carries a cup, in world units. */
const RADIUS = 6.5;
const RISE = 4.2;

/**
 * World units tall a cup is at its biggest.
 *
 * A third of the machine's height: a handful of trophies, not a rack of props.
 * Bigger than this and the burst hides the mech it is celebrating.
 */
const SIZE = 4;

/** Height up the mech the cups are collected into: the cockpit, not the feet. */
const CHEST = 6;

/** Where a cup starts - at the machine's body, before it is thrown clear. */
const START = 1.6;

/** One cup's performance. */
interface Cup {
  readonly sprite: Sprite;
  readonly material: SpriteMaterial;
  /** Unit bearing it is thrown along, and how far and how high it goes. */
  readonly dirX: number;
  readonly dirZ: number;
  readonly reach: number;
  readonly rise: number;
  /** Screen-space tilt it settles at, in radians. */
  readonly tilt: number;
  /** Seconds since this cup's beat began. Negative while it waits its turn. */
  time: number;
  active: boolean;
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * THE WIN CELEBRATION: trophies thrown clear of the mech, then collected into
 * it.
 *
 * A stage is the longest thing a player does in this game, so banking one has
 * to land as an event rather than as a number quietly changing. Cups burst out
 * of the machine's body, hang for a beat at the top of their arc, and are then
 * drawn back into the cockpit, shrinking and fading as they arrive.
 *
 * THE ORDER IS THE WHOLE POINT. Thrown OUT first, so it reads as a
 * celebration; gathered IN afterwards, so it reads as the prize being
 * collected rather than as decoration that happened to stop. A cup that
 * reached the mech at full size and blinked out would read as deleted, so the
 * fade and the shrink finish exactly as it arrives.
 *
 * It plays IN THE WORLD, around the machine the player is already looking at.
 * The version this replaced flew HTML images to the Wins counter - a flourish
 * in the corner of the screen while the player watched their mech.
 *
 * HOW MANY CUPS IS THE ACTUAL AWARD, and it is logarithmic because the ladder
 * is: stage rewards run from 1 to 350,000, so anything linear would be four
 * cups for the first twenty stages and a wall of gold for the last one.
 *
 * ONE AWARD IS ONE CELEBRATION. `play` is called from the server's award
 * message and from nowhere else - nothing here polls a position or a pad, so
 * standing on a win area cannot make it fire again.
 *
 * WHY SPRITES. A `Sprite` always faces the camera, so a cup is one quad
 * however the player has spun the view, and the art is the file the game was
 * given rather than a model somebody would have to build and light. Twelve
 * quads sharing one texture is nothing on a phone - and when nothing is in the
 * air, `update` returns on its first line.
 *
 * IT TOUCHES NOTHING ELSE. No physics, no input, no collision, no state: it is
 * handed a position and a figure, and it draws.
 */
export class WinTrophies {
  readonly root = new Group();

  private readonly cups: Cup[] = [];

  /** True while at least one cup is in the air, so the idle cost is one test. */
  private live = false;

  constructor() {
    const map = loadSharedImage(TROPHY_URL);

    for (let i = 0; i < POOL; i += 1) {
      /*
       * Thrown on FIXED bearings, and spaced by the GOLDEN ANGLE.
       *
       * Fixed, because a burst that scattered differently every time never
       * reads as deliberate. Golden-angle rather than an even ring, because
       * the number of cups varies with the award: an even ring only looks even
       * when every slot is used, and this stays well spread at four cups and
       * at twelve. The variation is in the reach and the height instead, which
       * gives the depth without the mess.
       */
      const angle = i * 2.399963;
      const wobble = ((i * 7) % 5) / 5;

      const material = new SpriteMaterial({
        map,
        transparent: true,
        depthWrite: false,
        /*
         * NOT DEPTH-TESTED, which is the whole reason a dozen cups read as one
         * burst.
         *
         * Half the fan is behind the machine from any given angle, and a cup
         * that vanished for the middle of its flight and reappeared at the end
         * would look like dropped frames rather than like a prize being
         * collected. Drawn over the world at a `renderOrder` above it, they
         * are a celebration laid over the scene - which is what they are.
         */
        depthTest: false,
        /*
         * NORMAL blending, so the art looks like the art.
         *
         * These were additive, on the reasoning that gold over a dark hangar
         * should read as light. What it actually did was wash the cups out:
         * additive ADDS to whatever is behind, so a bright gold sprite over a
         * dark deck climbs towards white, and two overlapping cups - which is
         * most of the burst - blow out completely. The supplied PNG is already
         * a lit gold cup with its own highlights; it needs compositing, not
         * amplifying.
         *
         * `fog: false` for the same reason: this is artwork, not a surface, and
         * it should not take on the colour of the hall it is flying through.
         */
        fog: false,
        opacity: 0,
      });

      const sprite = new Sprite(material);
      sprite.visible = false;
      sprite.scale.setScalar(SIZE);
      /*
       * Drawn LAST, and per sprite.
       *
       * `renderOrder` is a property of the object being drawn, so setting it
       * on the group above these would do exactly nothing - the cups would
       * still be sorted among the world's own transparent objects and could
       * flicker against the trail ribbons and the lit pads they fly over.
       */
      sprite.renderOrder = 10;
      this.root.add(sprite);

      this.cups.push({
        sprite,
        material,
        dirX: Math.cos(angle),
        dirZ: Math.sin(angle),
        reach: RADIUS * (0.72 + wobble * 0.5),
        rise: RISE * (0.6 + wobble * 0.8),
        tilt: (i % 2 === 0 ? 1 : -1) * (0.12 + wobble * 0.22),
        time: 0,
        active: false,
      });
    }
  }

  /**
   * Keep the burst on the machine. Called every frame with the mech's feet.
   *
   * THIS IS WHY THE EFFECT WAS INVISIBLE, and it is worth the paragraph.
   *
   * The position used to be snapshotted in `play`, on the reasoning that the
   * player stands still during the animation. They do not: banking a stage
   * makes the server send the award AND THEN TELEPORT THE PLAYER HOME, in that
   * order. So the cups were placed at the win pad - which by the next frame was
   * four hundred units behind the player, who arrived in the hangar to see
   * nothing at all. Every part of the effect was working; it was playing in an
   * empty room.
   *
   * Following costs one vector copy a frame, and it is also simply more
   * correct: the celebration belongs to the MECH, wherever the mech is.
   */
  follow(at: Vector3): void {
    this.root.position.copy(at);
  }

  /**
   * Celebrate ONE award.
   *
   * @param wins the figure the SERVER awarded, so the size of the celebration
   *             is the size of the prize.
   */
  play(wins: number): void {
    this.live = true;

    const paid = Number.isFinite(wins) ? Math.max(1, wins) : 1;
    const count = Math.min(POOL, FEWEST + Math.round(Math.log10(1 + paid) * 2.2));

    for (let i = 0; i < this.cups.length; i += 1) {
      const cup = this.cups[i];
      if (!cup) continue;

      // Cups past this award's handful are parked rather than drawn. Starting
      // the whole pool and hiding the surplus would be the same work for a
      // single-Win stage as for the last one in the game.
      if (i >= count) {
        cup.active = false;
        cup.sprite.visible = false;
        cup.material.opacity = 0;
        continue;
      }

      cup.time = -i * STAGGER;
      cup.active = true;
      cup.sprite.visible = true;
      cup.material.opacity = 0;
      cup.material.rotation = 0;
      cup.sprite.position.set(0, START, 0);
      cup.sprite.scale.setScalar(SIZE * 0.3);
    }
  }

  /** Advance every cup in the air. Does nothing at all when none is. */
  update(delta: number): void {
    if (!this.live) return;

    let anyLive = false;
    for (const cup of this.cups) {
      if (!cup.active) continue;

      cup.time += delta;
      if (cup.time < 0) {
        anyLive = true;
        continue;
      }
      if (cup.time >= LIFE) {
        // Spent: hidden and released back to the pool, which is the whole of
        // "remove it after the animation completes".
        cup.active = false;
        cup.sprite.visible = false;
        cup.material.opacity = 0;
        continue;
      }
      anyLive = true;

      if (cup.time < BURST + HANG) {
        /*
         * OUT AND UP: the celebration.
         *
         * Eased OUT, so the cup leaves the machine fast and settles at the top
         * of its arc rather than drifting there - the shape of something
         * thrown. The hang that follows holds that pose, which is what gives
         * the eye a moment to see a handful of trophies in the air before they
         * start coming back.
         */
        const t = easeOut(clamp01(cup.time / BURST));
        cup.sprite.position.set(
          cup.dirX * cup.reach * t,
          START + (cup.rise - START) * t,
          cup.dirZ * cup.reach * t,
        );
        cup.material.opacity = clamp01(cup.time / (BURST * 0.45));
        cup.material.rotation = cup.tilt * t;
        cup.sprite.scale.setScalar(SIZE * (0.3 + 0.7 * t));
        continue;
      }

      /*
       * IN AND GONE: the collection.
       *
       * Eased IN from where the throw left it to the cockpit, fading and
       * shrinking the whole way so the cup is spent exactly as it arrives.
       * That is the "collected into the player" half: it is absorbed, not
       * parked and not switched off.
       */
      const t = clamp01((cup.time - BURST - HANG) / COLLECT);
      const travel = easeIn(t);
      cup.sprite.position.set(
        cup.dirX * cup.reach * (1 - travel),
        cup.rise + (CHEST - cup.rise) * travel,
        cup.dirZ * cup.reach * (1 - travel),
      );
      cup.material.opacity = 1 - easeIn(t);
      cup.material.rotation = cup.tilt * (1 - travel);
      cup.sprite.scale.setScalar(SIZE * (1 - 0.65 * travel));
    }

    this.live = anyLive;
  }

  dispose(): void {
    for (const cup of this.cups) {
      cup.material.dispose();
      cup.sprite.removeFromParent();
    }
    this.cups.length = 0;
    this.root.removeFromParent();
  }
}
