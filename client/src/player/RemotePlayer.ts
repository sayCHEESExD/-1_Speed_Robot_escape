import { DEATH } from '../config/animationConfig.js';
import { createAnimationInput, type AnimationInput } from '../animation/AnimationInput.js';
import type { NetPlayerState } from '../net/netTypes.js';
import { AvatarDresser } from '../bloxity/AvatarDresser.js';
import { lookFromState } from '../bloxity/avatarLook.js';
import { Mount } from './Mount.js';

/** Seconds a remote transform is smoothed over. */
const FOLLOW_RATE = 14;

/** Distance past which a remote is placed rather than eased. */
const SNAP_DISTANCE = 12;

const shortestAngle = (from: number, to: number): number => {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
};

/**
 * Another player's mount.
 *
 * Rendered from replicated state ONLY. Its animation is reconstructed locally
 * by the very same animators the local player runs, driven from the handful of
 * motion fields on the wire - there are no bone transforms and no robot part
 * transforms in the protocol, and there never should be.
 *
 * Remotes are "ghosted", and that word means exactly one thing: they do not
 * collide, so they can never block another player's run. They render
 * completely normally - opaque, no fade, no ghost material.
 */
export class RemotePlayer {
  readonly mount: Mount;

  /** Latest authoritative transform, eased toward every frame. */
  private targetX = 0;
  private targetY = 0;
  private targetZ = 0;
  private targetYaw = 0;

  private readonly input: AnimationInput = createAnimationInput();



  /** Death counter last seen, so an increase triggers one fall-over. */
  private lastDeathCount = -1;
  /** Seconds into the fall-over, or -1. */
  private deathTime = -1;

  /** True while this remote is running on a belt. */
  private onTreadmill = false;

  private placed = false;

  /**
   * This player's Bloxity appearance, built from replicated ids.
   *
   * Remote riders used to keep the bundled character on the grounds that
   * fetching somebody else's cosmetics was a lot of traffic for something
   * glimpsed in passing. That is no longer the trade: the ids arrive as part
   * of the patch that was coming anyway, and every asset behind them is cached
   * by URL, so a lobby of ten players in the same starter skin fetches it
   * once.
   */
  /**
   * The AUTHORITATIVE position, straight off the last patch.
   *
   * Exposed because the closest-player rule has to rank players that are not
   * being drawn, and a hidden player's `mount.root` is not being interpolated
   * toward anything - it is parked wherever it was when it left the scene.
   * Ranking against that would keep somebody invisible precisely because they
   * are invisible.
   */
  get position(): { readonly x: number; readonly y: number; readonly z: number } {
    return { x: this.targetX, y: this.targetY, z: this.targetZ };
  }

  private readonly dresser: AvatarDresser;
  /** The look last applied, so an unchanged patch does nothing. */
  private lastLook = '';

  constructor(state: NetPlayerState) {
    this.mount = new Mount(state.robotSlot);
    this.dresser = new AvatarDresser(this.mount);
    this.apply(state);
    this.mount.setPosition(this.targetX, this.targetY, this.targetZ);
    this.mount.setYaw(this.targetYaw);
    this.placed = true;
    // A remote joining mid-session must not immediately play a death for every
    // one they have ever had: the counter is a LIFETIME total, so it only
    // means anything as a difference against the baseline taken on first
    // sight.
    this.lastDeathCount = state.deathCount;
  }

  /** Copy the replicated fields in. Called on every patch for this player. */
  apply(state: NetPlayerState): void {
    this.targetX = state.x;
    this.targetY = state.y;
    this.targetZ = state.z;
    this.targetYaw = state.rotationY;

    this.input.grounded = state.grounded;
    // A remote on a treadmill reports zero velocity, so the run cycle is fed
    // the speed they are running AT - otherwise they would idle on the spot.
    this.input.horizontalSpeed =
      state.treadmill > 0 ? 24 * state.moveMultiplier : state.speed;
    this.input.moveMultiplier = state.moveMultiplier;
    this.input.verticalVelocity = state.verticalVelocity;
    this.onTreadmill = state.treadmill > 0;

    this.mount.setRobotSlot(state.robotSlot);
    this.mount.setTrailSlot(state.trailSlot);
    this.dressFrom(state);

    if (this.lastDeathCount >= 0 && state.deathCount > this.lastDeathCount) {
      this.deathTime = 0;
    }
    this.lastDeathCount = state.deathCount;
  }

  /**
   * Wear whatever the room says this player is wearing.
   *
   * Called on every patch, so it is compared first: Colyseus re-delivers the
   * whole player object on any change, and rebuilding a body because somebody
   * moved would be a fetch per frame.
   */
  private dressFrom(state: NetPlayerState): void {
    const avatar = state.avatar;
    if (!avatar) return;

    const look = lookFromState(avatar);
    const key = JSON.stringify(look);
    if (key === this.lastLook) return;
    this.lastLook = key;

    this.dresser.setLook(look.appearance, look.proportions);
  }

  /** Advance interpolation and animation. */
  update(delta: number): void {
    const dt = Math.max(0, delta);

    const position = this.mount.root.position;
    const gap = Math.hypot(
      this.targetX - position.x,
      this.targetY - position.y,
      this.targetZ - position.z,
    );

    if (!this.placed || gap > SNAP_DISTANCE) {
      // A respawn or a long stall. Easing across it would drag the mount
      // through every metre of course in between.
      position.set(this.targetX, this.targetY, this.targetZ);
      this.mount.setYaw(this.targetYaw);
      this.placed = true;
    } else {
      const alpha = 1 - Math.exp(-FOLLOW_RATE * dt);
      position.x += (this.targetX - position.x) * alpha;
      position.y += (this.targetY - position.y) * alpha;
      position.z += (this.targetZ - position.z) * alpha;
      const yaw = this.mount.root.rotation.y;
      this.mount.setYaw(yaw + shortestAngle(yaw, this.targetYaw) * alpha);
    }

    if (this.deathTime >= 0) {
      this.deathTime += dt;
      if (this.deathTime > DEATH.duration) this.deathTime = -1;
    }
    this.input.dying = this.deathTime >= 0;

    // Edges are DERIVED from the replicated state rather than sent: a jump is
    // "was grounded, now is not", which is one comparison instead of an event
    // stream that could be replayed or lost.
    this.mount.update(dt, this.input);
    this.mount.updateEffects(
      dt,
      position.x,
      position.y,
      position.z,
      this.onTreadmill ? 0 : this.input.horizontalSpeed,
    );
  }

  dispose(): void {
    this.dresser.dispose();
    this.mount.dispose();
  }
}
