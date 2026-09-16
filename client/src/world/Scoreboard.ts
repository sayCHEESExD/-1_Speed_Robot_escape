import { COURSE, LEADERBOARD_SIZE, formatSpeed } from '@robot/shared';
import {
  CanvasTexture,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type BufferGeometry,
} from 'three';
import type { LeaderboardSnapshot, NetLeaderEntry } from '../net/netTypes.js';
import { PALETTE } from '../config/worldVisuals.js';
import { logger } from '../util/logger.js';
import { CanvasSign } from './CanvasSign.js';
import { texturedBox } from './texturedBox.js';

const SCOPE = 'Scoreboard';

/**
 * Which board is which.
 *
 * TWO, and only two: Top Wins and Top Speed. The server still ranks rebirths -
 * `LeaderboardService` fills all three arrays and always has - but a third
 * board is not shown, because the entrance has exactly two sides and a board
 * that had to go somewhere else would stop being part of the gate.
 */
type Category = 'wins' | 'speed';

interface BoardSpec {
  readonly category: Category;
  /** The big floating word above the board. */
  readonly title: string;
  /** The header printed on the panel itself. */
  readonly heading: string;
  readonly titleFill: string;
  readonly titleStroke: string;
  /** Where it stands, as a fraction of the arena's half-width. */
  readonly x: number;
}

/**
 * The two boards, and which side of the entrance each stands on.
 *
 * TOP WINS on the player's LEFT and TOP SPEED on their RIGHT, exactly as
 * specified - and in this game LEFT IS POSITIVE X. The camera looks down +Z
 * and its right is `(-cos yaw, sin yaw)`, which at yaw 0 is world -X, so a
 * board authored at a negative X is on the player's right however "left-hand"
 * the number reads. Getting this backwards puts both titles on the wrong side
 * of the doorway, which is the one mistake nobody notices until a screenshot.
 */
const BOARDS: readonly BoardSpec[] = [
  {
    category: 'wins',
    title: 'TOP WINS',
    heading: 'MOST WINS',
    titleFill: '#ffd53d',
    titleStroke: '#5a3400',
    x: 1,
  },
  {
    category: 'speed',
    title: 'TOP SPEED',
    heading: 'MOST SPEED',
    titleFill: '#5df2ff',
    titleStroke: '#063243',
    x: -1,
  },
];

/** Board footprint, in world units. */
const BOARD = {
  /*
   * COMMAND DISPLAYS, sized against the mech that reads them.
   *
   * A machine nine units tall standing in a hangar a hundred and ninety wide
   * needs a screen it can read from the middle of the room, and these are
   * forty across - about four times the width of the thing looking at them.
   * Anything smaller reads as a notice board rather than as a fixture of the
   * building, which was exactly the previous version's problem.
   *
   * They stand either side of the mouth of the course. The gap between them
   * has to stay comfortably wider than the 92-unit doorway or the pair becomes
   * a pinch point in the one route every run goes through.
   */
  width: 44,
  height: 34,
  /** Thickness of the steel case around the glass. */
  frame: 3.2,
  /** How far the whole cabinet stands off the bulkhead. */
  depth: 3.2,
  /** Height of the panel's bottom edge above the deck. */
  baseY: 9,
} as const;

/** Canvas pixels per world unit on the panel. Enough to read from the spawn. */
const PIXELS_PER_UNIT = 46;

/** Medal colours for the first three places, then everyone else. */
const RANK_COLOURS = ['#ffd53d', '#dfe6ef', '#ff9a3d'] as const;
const RANK_DEFAULT = '#ffffff';

/*
 * The command display's typeface, and the facility's.
 *
 * The same DIN-derived stack every sign in the world is set in - see
 * CanvasSign - so a board and the gate beyond it are plainly the same
 * building's signage. The ranked figures beside it are set in a MONOSPACE
 * instead, because a column of numbers that do not line up is the one thing a
 * leaderboard cannot get away with.
 */
const FONT = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Segoe UI Semibold", system-ui, sans-serif';
const MONO = 'ui-monospace, "Cascadia Mono", "Consolas", "Roboto Mono", monospace';

/**
 * The two leaderboards framing the mouth of the course.
 *
 * WORLD-SPACE, not HUD. The reference art puts these either side of the
 * entrance the player is about to walk through, and that is the whole
 * character of them: they are a place you walk up to and read, and something
 * another player can be seen looking at. A flat panel pinned to the corner of
 * the screen would be a different feature wearing the same numbers.
 *
 * TOP WINS on the left and TOP SPEED on the right, and nothing else. Two
 * boards is the specification and it is also the right number for a doorway.
 *
 * Every figure comes from replicated server state and this draws it. There is
 * no client-side ranking, no local tally, and nothing here that could disagree
 * with what the server decided the order was.
 */
export class Scoreboard {
  readonly root = new Group();

  private readonly panels: PanelSurface[] = [];
  private readonly signs: CanvasSign[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: (MeshBasicMaterial | MeshLambertMaterial)[] = [];

  /** So the "no leaderboard" complaint is made once, not sixty times a second. */
  private warnedMissing = false;

  constructor() {
    /*
     * FRAMING THE COURSE ENTRANCE, facing back down the hangar at the spawn
     * point.
     *
     * They stand just inside the hangar's far end and turned to face -Z, so a
     * player walking toward the first stage reads them on the way past and a
     * player standing at spawn sees both with the lit "STAGE 1 ESCAPE" sign
     * between them. That stretch of the hangar was deliberately left empty
     * when the room was laid out; this is what it was left empty for, and it
     * stays the only thing there.
     *
     * The spread is measured from the corridor, not from the panels: each
     * board is pushed out until its inner edge clears the mouth of the course,
     * so neither can ever overhang the doorway.
     */
    const wallZ = COURSE.lobbyEndZ - 13;
    const outer = BOARD.width + BOARD.frame * 2;
    const spread = COURSE.halfWidth + outer / 2 + 5;

    const stone = this.material(
      new MeshLambertMaterial({ color: PALETTE.boardFrame }),
    );
    const stoneDark = this.material(
      new MeshLambertMaterial({ color: PALETTE.boardFrameDark }),
    );

    for (const spec of BOARDS) {
      const group = new Group();
      group.position.set(spec.x * spread, 0, wallZ);
      // Turned to face back into the hangar. A sign is single-sided, so one
      // left facing +Z would be invisible from the only place anybody reads it
      // from.
      group.rotation.y = Math.PI;

      const midY = BOARD.baseY + BOARD.height / 2;
      const outerW = BOARD.width + BOARD.frame * 2;
      const outerH = BOARD.height + BOARD.frame * 2;

      // The surround, as four bars rather than one slab behind the panel: a
      // frame you can see the thickness of is what makes this masonry instead
      // of a poster.
      const bars: readonly (readonly [number, number, number, number])[] = [
        [0, midY + BOARD.height / 2 + BOARD.frame / 2, outerW, BOARD.frame],
        [0, midY - BOARD.height / 2 - BOARD.frame / 2, outerW, BOARD.frame],
        [-BOARD.width / 2 - BOARD.frame / 2, midY, BOARD.frame, BOARD.height],
        [BOARD.width / 2 + BOARD.frame / 2, midY, BOARD.frame, BOARD.height],
      ];
      for (const [bx, by, bw, bh] of bars) {
        group.add(this.box(stone, bx, by, 0, bw, bh, BOARD.depth));
      }

      // Corner blocks, and the legs it stands on.
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          group.add(
            this.box(
              stoneDark,
              sx * (outerW / 2 - BOARD.frame / 2),
              midY + sy * (outerH / 2 - BOARD.frame / 2),
              0.25,
              BOARD.frame * 1.5,
              BOARD.frame * 1.5,
              BOARD.depth + 0.6,
            ),
          );
        }
        /*
         * The legs, and they are STRUCTURE rather than trim.
         *
         * A display this size hanging in mid-air over a hangar deck reads as a
         * poster. Two heavy stanchions down to the floor, plus a brace back to
         * the bulkhead behind, make it a cabinet somebody bolted in - which is
         * the whole difference between signage and architecture.
         */
        group.add(
          this.box(
            stoneDark,
            sx * (BOARD.width / 2 - 2.5),
            BOARD.baseY / 2,
            0,
            5.5,
            BOARD.baseY,
            BOARD.depth,
          ),
        );
        group.add(
          this.box(
            stoneDark,
            sx * (BOARD.width / 2 - 2.5),
            BOARD.baseY + 4,
            -BOARD.depth * 2,
            3,
            3,
            BOARD.depth * 4,
          ),
        );
      }

      // The panel itself: one plane carrying a canvas that is redrawn whenever
      // the standings change.
      const surface = new PanelSurface(spec, BOARD.width, BOARD.height);
      surface.mesh.position.set(0, midY, BOARD.depth / 2 + 0.02);
      group.add(surface.mesh);
      this.panels.push(surface);

      // The big floating word above it.
      const title = new CanvasSign(outerW * 0.85, 11, [
        {
          text: spec.title,
          size: 1,
          fill: spec.titleFill,
          stroke: spec.titleStroke,
          // A HAIRLINE, not a rim: these are lit letters on a command
          // display, and a heavy outline is what made them read as stickers.
          strokeWidth: 0.07,
        },
      ]);
      title.mesh.position.set(0, midY + outerH / 2 + 7.5, BOARD.depth / 2 + 0.4);
      group.add(title.mesh);
      this.signs.push(title);

      this.root.add(group);
    }
  }

  /**
   * Take the latest standings.
   *
   * Cheap to call every frame: each panel compares a signature of what it was
   * asked to draw against what it last drew, and a canvas is only re-rendered
   * and re-uploaded when something has actually moved. The board changes every
   * couple of seconds at most, and redrawing two 1400-pixel canvases at sixty
   * hertz for that would cost more than the rest of the world put together.
   */
  update(board: LeaderboardSnapshot | null): void {
    if (!board) {
      /*
       * The server sent no leaderboard at all.
       *
       * Not "no scores" - no FIELD. The only way that happens is a server
       * whose `CourseState` has no `leaderboard` on it, which means the
       * deployed server is older than the deployed client. Everything else
       * about the session works, because every other field predates this one,
       * so the symptom is two blank boards and no other clue at all.
       *
       * Said ONCE, and loudly enough to find. Silence here cost a deployment.
       */
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        logger.warn(
          SCOPE,
          'the server sent no leaderboard: its state has no such field, which ' +
            'means it is running an older build than this client. Redeploy the ' +
            'Colyseus server.',
        );
        for (const panel of this.panels) panel.showUnavailable();
      }
      return;
    }

    this.warnedMissing = false;
    for (const panel of this.panels) panel.apply(board[panel.category]);
  }

  dispose(): void {
    for (const panel of this.panels) panel.dispose();
    for (const sign of this.signs) sign.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.panels.length = 0;
    this.signs.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.root.removeFromParent();
  }

  private box(
    material: MeshLambertMaterial,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ): Mesh {
    const geometry = texturedBox(w, h, d, 4);
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private material<T extends MeshBasicMaterial | MeshLambertMaterial>(material: T): T {
    this.materials.push(material);
    return material;
  }
}

/**
 * One board's face: a canvas, a texture and the plane showing it.
 *
 * Unlit, like every other piece of world text in this game. A board that
 * dimmed when the sun went behind it is a board nobody can read.
 */
class PanelSurface {
  readonly mesh: Mesh;
  readonly category: Category;

  private readonly spec: BoardSpec;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;

  /** What was last drawn, so an unchanged board is not redrawn. */
  private signature = '';

  /** The line shown instead of rows when nothing is ranked yet. */
  private placeholder = 'No scores yet';

  constructor(spec: BoardSpec, width: number, height: number) {
    this.spec = spec;
    this.category = spec.category;

    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * PIXELS_PER_UNIT);
    this.canvas.height = Math.round(height * PIXELS_PER_UNIT);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;

    this.geometry = new PlaneGeometry(width, height);
    this.material = new MeshBasicMaterial({ map: this.texture, side: FrontSide });
    this.mesh = new Mesh(this.geometry, this.material);

    this.draw([]);
  }

  apply(rows: readonly NetLeaderEntry[]): void {
    const signature = rows.map((row) => `${row.handle}:${row.value}`).join('|');
    if (signature === this.signature && this.placeholder === 'No scores yet') return;
    this.signature = signature;
    this.placeholder = 'No scores yet';
    this.draw(rows);
    this.texture.needsUpdate = true;
  }

  /**
   * Draw the board as UNAVAILABLE rather than merely empty.
   *
   * Used only when the server has no leaderboard field to send - a state the
   * player cannot fix and the operator has to know about.
   */
  showUnavailable(): void {
    this.placeholder = 'Scores unavailable';
    this.signature = '\u0000unavailable';
    this.draw([]);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
    this.mesh.removeFromParent();
  }

  private draw(rows: readonly NetLeaderEntry[]): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.canvas;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = PALETTE.boardPanel;
    ctx.fillRect(0, 0, width, height);

    // An inner bevel, so the panel reads as set INTO the frame around it.
    ctx.strokeStyle = PALETTE.boardPanelEdge;
    ctx.lineWidth = width * 0.012;
    ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, width - ctx.lineWidth * 2, height - ctx.lineWidth * 2);

    const pad = width * 0.05;
    const headerH = height * 0.16;

    // The header.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    fitText(ctx, this.spec.heading, width - pad * 2, headerH * 0.62);
    ctx.letterSpacing = `${headerH * 0.045}px`;
    ctx.lineWidth = headerH * 0.05;
    // The DARK ink, not white. The panel is dark slate, so a white halo round
    // a light heading would be the brightest thing on a board whose whole job
    // is to be read rather than looked at.
    ctx.strokeStyle = PALETTE.boardInk;
    ctx.strokeText(this.spec.heading, width / 2, headerH * 0.62);
    ctx.save();
    // The heading is a LIT line on a dark panel, so it spills a little.
    ctx.shadowColor = PALETTE.boardHeading;
    ctx.shadowBlur = headerH * 0.22;
    ctx.fillStyle = PALETTE.boardHeading;
    ctx.fillText(this.spec.heading, width / 2, headerH * 0.62);
    ctx.restore();
    ctx.letterSpacing = '0px';

    // A lit rule under the header, the way a console divides its regions.
    ctx.fillStyle = PALETTE.boardHeading;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(pad, headerH * 0.97, width - pad * 2, Math.max(1, height * 0.004));
    ctx.globalAlpha = 1;

    // The rows.
    const rowTop = headerH;
    const rowH = (height - headerH - pad * 0.6) / LEADERBOARD_SIZE;
    const rankX = pad;
    const handleX = pad + width * 0.13;
    const valueRight = width - pad;
    const handleRoom = valueRight - handleX - width * 0.2;

    /*
     * An empty board has to LOOK empty on purpose.
     *
     * A fresh server has no profiles and every live figure starts at zero, so
     * nothing is ranked and every row is blank - which is pixel-identical to
     * the board being broken. One line of text is the difference between "no
     * one has scored yet" and "this feature is dead", and on a newly deployed
     * server the first is what is actually true.
     */
    if (!rows.some((row) => row && row.handle)) {
      ctx.textAlign = 'center';
      ctx.fillStyle = PALETTE.boardHeading;
      fitText(ctx, this.placeholder, width - pad * 2, rowH * 0.62);
      ctx.globalAlpha = 0.75;
      ctx.fillText(this.placeholder, width / 2, rowTop + rowH * 1.6);
      ctx.globalAlpha = 1;
      return;
    }

    for (let i = 0; i < LEADERBOARD_SIZE; i += 1) {
      const row = rows[i];
      const centreY = rowTop + rowH * (i + 0.5);
      const size = rowH * 0.58;

      // A faint stripe on alternate rows: nine lines of similar text are much
      // easier to track across when the eye has something to follow.
      if (i % 2 === 1) {
        ctx.fillStyle = PALETTE.boardStripe;
        ctx.fillRect(pad * 0.4, rowTop + rowH * i, width - pad * 0.8, rowH);
      }
      if (!row || !row.handle) continue;

      ctx.textAlign = 'left';
      ctx.lineWidth = size * 0.08;
      ctx.strokeStyle = PALETTE.boardInk;

      // Rank, in its medal colour. Monospace, like the figure at the other end
      // of the row: the two columns of numbers on this board line up.
      ctx.font = `700 ${size}px ${MONO}`;
      ctx.fillStyle = RANK_COLOURS[i] ?? RANK_DEFAULT;
      const rank = `#${i + 1}`;
      ctx.strokeText(rank, rankX, centreY);
      ctx.fillText(rank, rankX, centreY);

      // Handle, shrunk to fit the space between the rank and the figure. It is
      // the one field whose length is not ours to choose, so it is the one
      // that has to give - and the figure beside it must never be pushed off
      // the board by a long name.
      fitText(ctx, row.handle, handleRoom, size, 'left');
      ctx.fillStyle = PALETTE.boardName;
      ctx.strokeText(row.handle, handleX, centreY);
      ctx.fillText(row.handle, handleX, centreY);

      // The figure, right-aligned so the column reads down the page.
      const text = this.format(row.value);
      ctx.textAlign = 'right';
      fitText(ctx, text, width * 0.24, size, 'right', true);
      ctx.fillStyle = PALETTE.boardValue;
      ctx.strokeText(text, valueRight, centreY);
      ctx.fillText(text, valueRight, centreY);
    }
  }

  /**
   * Both columns run to the millions, so both are compacted the same way.
   *
   * ONE formatter, and it is the same `formatSpeed` the HUD prints the
   * player's own total with - a board that abbreviated differently from the
   * counter it is being compared against would be worse than no board.
   */
  private format(value: number): string {
    return formatSpeed(value);
  }
}

/**
 * Set a font size that FITS, and leave it set.
 *
 * The same rule the world signs learned the hard way: a size chosen from the
 * row height alone, with nothing ever measured against the width available,
 * runs long text straight off the end of its own canvas. The stroke counts
 * too - `strokeText` paints half a line width outside the glyphs - so it is
 * budgeted for here rather than discovered later.
 */
const fitText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  room: number,
  preferred: number,
  align: CanvasTextAlign = 'center',
  mono = false,
): void => {
  ctx.textAlign = align;
  const family = mono ? MONO : FONT;
  let size = preferred;
  for (let pass = 0; pass < 4; pass += 1) {
    ctx.font = `700 ${size}px ${family}`;
    const drawn = ctx.measureText(text).width + size * 0.1;
    if (drawn <= room) break;
    size *= room / drawn;
  }
  ctx.font = `700 ${size}px ${family}`;
  ctx.lineWidth = size * 0.08;
};
