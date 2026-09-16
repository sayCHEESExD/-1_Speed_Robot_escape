import { STAGES, type StageDefinition } from '@robot/shared';
import type { Group } from 'three';
import type { CanvasSign } from './CanvasSign.js';

/**
 * How far ahead of the player a stage's signage is built, in world units.
 *
 * BEYOND THE FOG, and that is the whole requirement. The fog closes completely
 * at `WORLD_FOG.far` (1100), so anything built further away than that cannot be
 * seen arriving - a sign revealed at 1400 units has already existed for three
 * hundred units by the time there is any chance of seeing it. Cutting this
 * below the fog distance would trade a load spike for visible pop-in, which is
 * a worse bug than the one this fixes.
 *
 * The course averages about 550 units a stage, so this is two to three stages
 * of lookahead - and a player standing in the hangar pays for three stages of
 * signage instead of thirty.
 */
const REVEAL_AHEAD = 1400;

/**
 * BUILD A STAGE'S SIGNAGE WHEN THE PLAYER GETS NEAR IT, NOT AT STARTUP.
 *
 * Every sign in this game is a canvas drawn at runtime and uploaded as a
 * texture, and there are two per stage - the gate indicator and the win pad's
 * payout label. Built for all thirty stages the moment the world was
 * constructed, those sixty canvases were a hundred megabytes of GPU memory and
 * sixty uploads, every one of them for a stage the player cannot see from the
 * spawn and most of them for stages they will not reach this session. On a
 * phone that was most of the tab's memory budget spent before the first frame.
 *
 * The COURSE ITSELF is not deferred and must not be: its geometry is merged
 * into a handful of meshes precisely so that thirty stages cost a handful of
 * draw calls, and building that incrementally would mean re-merging, which is
 * far more expensive than building it once. Signs are the opposite shape - one
 * mesh and one texture each, independent of every other - so they are the part
 * that can be deferred without unpicking anything.
 *
 * Nothing is ever destroyed. A revealed stage stays built: a player who runs
 * back and forth across a boundary would otherwise rebuild the same canvas
 * over and over, which is the cost this exists to avoid.
 */
export class StageReveal {
  private readonly root: Group;
  private readonly make: (stage: StageDefinition) => CanvasSign;
  private readonly built = new Map<number, CanvasSign>();
  /** Furthest Z already satisfied, so a still player costs one compare. */
  private reachedZ = Number.NEGATIVE_INFINITY;

  constructor(root: Group, make: (stage: StageDefinition) => CanvasSign) {
    this.root = root;
    this.make = make;
  }

  /**
   * Build anything now close enough to matter.
   *
   * Called every frame with the player's Z. The early return is what makes
   * that free: the common case is a player who has not crossed a new stage's
   * horizon since the last frame, and that costs one number comparison.
   */
  revealNear(z: number): void {
    if (z <= this.reachedZ) return;
    this.reachedZ = z;

    const horizon = z + REVEAL_AHEAD;
    for (const stage of STAGES) {
      // The list is ordered along the course, so the first stage past the
      // horizon ends the search.
      if (stage.startZ > horizon) break;
      if (this.built.has(stage.index)) continue;
      const sign = this.make(stage);
      this.root.add(sign.mesh);
      this.built.set(stage.index, sign);
    }
  }

  dispose(): void {
    for (const sign of this.built.values()) sign.dispose();
    this.built.clear();
  }
}
