import type { AudioManager } from './AudioManager.js';

/** Below this, the mech is not really moving and should be silent. */
const MIN_AUDIBLE_SPEED = 2.5;

/** World units of travel between two FOOTFALLS at a walk. */
const STRIDE_DISTANCE = 5.5;

/**
 * Most footfalls a second, so a late-game mech pounds rather than buzzes.
 *
 * The same clamp the walk ANIMATION uses and for the same reason: phase
 * advances with distance, and at four hundred units a second an unclamped
 * cadence is a tone, not a step. The two clamps are separate numbers because
 * they are tuned against different senses, but if either is ever changed alone
 * the mech's feet and its sound come apart.
 */
const MAX_STEPS_PER_SECOND = 5;

/** What the audio layer needs to know about the mount. Read-only. */
export interface PlayerAudioInput {
  readonly horizontalSpeed: number;
  readonly maxRunSpeed: number;
  readonly isGrounded: boolean;
  readonly justJumped: boolean;
  readonly justLanded: boolean;
  readonly isDying: boolean;
  /**
   * True while the player is on a treadmill.
   *
   * A runner on a belt has ZERO velocity and is very much running, so the
   * footfalls have to come from somewhere other than distance travelled - this
   * is the flag that says to use the belt's pace instead.
   */
  readonly onTreadmill: boolean;
}

/**
 * Turns what the local mech is doing into sounds.
 *
 * Deliberately separate from `AudioManager`: one knows how to make a noise,
 * the other knows when the game wants one. Game code then has a single
 * `update` to call, and no part of the renderer or the simulation ends up with
 * an opinion about audio.
 *
 * ONLY the local player is fed through here. Remote pilots are drawn and
 * animated but silent, because eight mechs walking past would bury the one
 * whose footfalls actually tell the player something.
 *
 * FOOTFALLS are the important one, and there are two ways to make them:
 *
 *  - THE SUPPLIED RECORDING, looped for as long as the mech is walking, with
 *    its rate tied to the pace. `robot steps.mp3` is three seconds of a mech
 *    walking rather than one footfall, so a loop is what it is, and one-shot
 *    retriggering would cut every step off before it finished.
 *  - THE SYNTHESISED THUD, one per stride, used when there is no recording to
 *    play. That one belongs to DISTANCE - a step is a foot hitting the deck,
 *    so it happens when the mech has covered a stride and not on a clock.
 *
 * The recording is asked first every frame and the stride counter only runs
 * when it says no, so the two can never both be sounding.
 */
export class PlayerAudio {
  private readonly audio: AudioManager;

  /** Distance since the last footfall. */
  private stride = 0;
  /** Seconds since the last footfall, for the cadence clamp. */
  private sinceBeat = 0;
  /** So a death fires once per death rather than once per frame. */
  private wasDying = false;

  constructor(audio: AudioManager) {
    this.audio = audio;
  }

  update(delta: number, player: PlayerAudioInput): void {
    // A death is an EDGE. `isDying` stays true for the whole fall-over, and
    // playing on the level rather than the edge would retrigger it every frame
    // for the length of the animation.
    if (player.isDying) {
      if (!this.wasDying) {
        this.wasDying = true;
        // THE DEATH, and it is the supplied `fall.mp3` - see `SAMPLE_URLS`.
        this.audio.play('death');
      }
      this.stride = 0;
      // Feet stop the instant the machine goes over. A walking loop still
      // running under a fall-over is the single most obvious way canned audio
      // gives itself away.
      this.audio.setFootsteps(false, 0);
      return;
    }
    this.wasDying = false;

    if (player.justJumped) this.audio.play('jump');
    if (player.justLanded) this.audio.play('land', this.loudness(player));

    this.sinceBeat += delta;

    if (!player.isGrounded) {
      this.stride = 0;
      this.audio.setFootsteps(false, 0);
      return;
    }

    /*
     * The pace the feet are moving at, which is NOT always the pace the mech
     * is travelling at.
     *
     * On a treadmill the two differ completely - the belt supplies the ground
     * and the position never changes - so the footfalls are driven from the
     * run speed instead. This is the same substitution the animator makes, and
     * it has to be, or the feet would be silent while visibly pounding.
     */
    const pace = player.onTreadmill ? player.maxRunSpeed : player.horizontalSpeed;
    if (pace < MIN_AUDIBLE_SPEED) {
      this.stride = 0;
      this.audio.setFootsteps(false, 0);
      return;
    }

    /*
     * The recording first. While it is playing there is nothing for the stride
     * counter to do, and running both would double every footfall.
     */
    if (this.audio.setFootsteps(true, this.loudness(player))) {
      this.stride = 0;
      return;
    }

    this.stride += pace * delta;
    if (this.stride < STRIDE_DISTANCE) return;
    if (this.sinceBeat < 1 / MAX_STEPS_PER_SECOND) {
      // Over the cadence ceiling: drop the beat rather than banking it, or a
      // fast mech would pay off a debt of steps the moment it slowed.
      this.stride = 0;
      return;
    }

    this.stride = 0;
    this.sinceBeat = 0;
    this.audio.play('step', 0.3 + this.loudness(player) * 0.5);
  }

  /** Louder the faster the mech is going, as a fraction of its own top speed. */
  private loudness(player: PlayerAudioInput): number {
    const top = Math.max(1, player.maxRunSpeed);
    const pace = player.onTreadmill ? top : player.horizontalSpeed;
    return Math.min(pace / top, 1);
  }
}
