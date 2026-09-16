import { COURSE } from '@robot/shared';
import { Group } from 'three';
import { CanvasSign } from './CanvasSign.js';
import type { SignLine } from './CanvasSign.js';
import { StageReveal } from './StageReveal.js';

/**
 * The stage indicator at the head of each stage.
 *
 * FLOATING TEXT, AND NOTHING ELSE. "STAGE 1" hanging over the mouth of the
 * first stage, "STAGE 2" over the second, and so on. There is no panel behind
 * it, no frame around it, no jambs beside it and no slab across the course -
 * the previous version was a seventy-four unit lit billboard bolted over the
 * entrance, and however well it was drawn it was a wall between the player and
 * the thing they were about to run.
 *
 * The number is the whole headline: a stage is known by its number in this
 * game and by nothing else, which is what makes a thirty-stage run legible
 * from the hangar.
 *
 * STAGE ONE, AND ONLY STAGE ONE, ALSO SAYS **ESCAPE**. It is the word the game
 * is named for and the promise it opens on, so it appears exactly once: under
 * the number at the mouth of the first stage, in the cyan that means "this
 * way". Putting it on every gate would turn the one line the player is meant
 * to remember into a heading they stop reading.
 *
 * Hung HIGH and just inside the stage, facing back down the course at the
 * player approaching it. High because the text must not sit in front of the
 * first obstacle - an indicator that obscures the thing it introduces is worse
 * than no indicator - and facing back because a sign you read as you arrive is
 * a sign, and one you read as you leave is a plaque.
 */
export class StageSigns {
  readonly root = new Group();

  /*
   * BUILT AS THE PLAYER ARRIVES, not all thirty at startup. Each of these is a
   * canvas and a texture upload, and the twenty-eight the player cannot see
   * from the spawn were a large part of what a phone spent its memory on
   * before the first frame. See `StageReveal`.
   */
  private readonly reveal = new StageReveal(this.root, (stage) => {
    {
      const lines: SignLine[] = [
        {
          // THE headline, and it is a number. Big enough to read from the
          // previous stage's finish apron.
          text: `STAGE ${stage.index}`,
          size: 1,
          fill: '#ffffff',
          stroke: '#04070d',
          strokeWidth: 0.07,
        },
      ];

      // The one word that appears once in the whole game.
      if (stage.index === 1) {
        lines.push({
          text: 'ESCAPE',
          size: 0.7,
          fill: '#5df2ff',
          stroke: '#02161d',
          strokeWidth: 0.07,
        });
      }

      /*
       * The canvas is sized to the TEXT, not to a panel.
       *
       * `CanvasSign` clears its canvas to transparent and its material is
       * transparent with `depthWrite` off, so what ends up in the world is the
       * glyphs and their bloom - the plane around them draws nothing at all.
       */
      const sign = new CanvasSign(46, stage.index === 1 ? 18 : 11, lines);
      sign.mesh.position.set(0, COURSE.floorY + 34, stage.startZ + 16);
      sign.mesh.rotation.y = Math.PI;
      return sign;
    }
  });

  /** Build whatever the player has come close enough to see. */
  revealNear(z: number): void {
    this.reveal.revealNear(z);
  }

  dispose(): void {
    this.reveal.dispose();
    this.root.removeFromParent();
  }
}
