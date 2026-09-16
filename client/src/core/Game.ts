import {
  STARTER_ROBOT_SLOT,
  type RespawnMessage,
  type StageAwardedMessage,
} from '@robot/shared';
import { AudioManager } from '../audio/AudioManager.js';
import { Bloxity } from '../bloxity/Bloxity.js';
import { AvatarDresser } from '../bloxity/AvatarDresser.js';
import { lookFromLegion } from '../bloxity/avatarLook.js';
import { PlayerAudio } from '../audio/PlayerAudio.js';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera.js';
import { clientConfig } from '../config/clientConfig.js';
import { InputManager } from '../input/InputManager.js';
import { NetworkClient } from '../net/NetworkClient.js';
import type { ConnectionStatus, NetPlayerState } from '../net/netTypes.js';
import { LocalPlayer } from '../player/LocalPlayer.js';
import { playerModelLoader, type PlayerModelReport } from '../player/PlayerModelLoader.js';
import { RemotePlayerManager } from '../player/RemotePlayerManager.js';
import { RunController } from '../progression/RunController.js';
import { RendererManager } from '../rendering/RendererManager.js';
import { SceneManager } from '../rendering/SceneManager.js';
import { Panel, anyPanelOpen } from '../ui/Panel.js';
import { RailButton } from '../ui/RailButton.js';
import { RebirthPanel } from '../ui/RebirthPanel.js';
import { SpeedHud } from '../ui/SpeedHud.js';
import { SpeedPopups } from '../ui/SpeedPopups.js';
import { MechShop } from '../ui/MechShop.js';
import { TrailShop } from '../ui/TrailShop.js';
import { BloxityPanel } from '../ui/BloxityPanel.js';
import { WinsCounter } from '../ui/WinsCounter.js';
import { ICONS, injectHudStyles } from '../ui/hudStyles.js';
import { logger } from '../util/logger.js';
import { CourseWorld } from '../world/CourseWorld.js';

const SCOPE = 'Game';

/**
 * Which shortcut a key event means, or '' for none.
 *
 * Reads `code` FIRST and falls back to `key`, and that fallback is the whole
 * point of this function. `code` is the physical key and is the right thing to
 * bind to, but it is not always populated: on-screen keyboards, remote-input
 * and automation paths, and some IME states all deliver a perfectly ordinary
 * keystroke with `code` set to the empty string. Matching on `code` alone
 * meant those keystrokes silently did nothing - the shortcuts looked
 * implemented and were not, which is exactly how they shipped broken.
 *
 * Returns a lower-case name so the two sources collapse to one value and the
 * caller has a single thing to switch on.
 */
const shortcutOf = (event: KeyboardEvent): string => {
  const code = event.code;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code) return code.toLowerCase();
  // No physical code. The typed character is what is left, and for these
  // shortcuts - single letters and Escape - it says the same thing.
  return (event.key || '').toLowerCase();
};

/**
 * True if the keystroke belongs to a field the player is typing in.
 *
 * Covers every element that takes text, not just `<input>`: a shortcut that
 * fired while someone typed in a textarea would be just as wrong.
 */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

/**
 * Composition root.
 *
 * Owns every subsystem and defines the per-frame update order, and holds no
 * gameplay rules of its own. The order below is the only thing here that
 * matters, and it is deliberate: input, then prediction, then triggers, then
 * the camera, then the network, then the render.
 */
export class Game {
  private readonly renderer: RendererManager;
  private readonly sceneManager = new SceneManager();
  private readonly camera = new ThirdPersonCamera();
  private readonly input = new InputManager();
  private readonly remotePlayers: RemotePlayerManager;
  private readonly hud: SpeedHud;
  private readonly pops: SpeedPopups;
  private readonly wins: WinsCounter;
  private readonly rail: HTMLDivElement;
  private readonly rebirthButton: RailButton;
  private readonly mechButton: RailButton;
  private readonly trailButton: RailButton;
  private readonly audioButton: RailButton;
  private readonly audio = new AudioManager();
  private readonly bloxity: Bloxity;
  private readonly bloxityPanel: BloxityPanel;
  private readonly fpsReadout: HTMLDivElement;
  /** Cosmetics on the local rider. Built once the model exists. */
  private dresser: AvatarDresser | null = null;
  /** Latest equipped/proportions, held until the rider is built. */
  private pendingAvatar: (() => void) | null = null;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private readonly playerAudio: PlayerAudio;
  private readonly rebirthPanel: RebirthPanel;
  private readonly mechShop: MechShop;
  private readonly trailShop: TrailShop;
  private readonly network: NetworkClient;
  private readonly world = new CourseWorld();
  private readonly run: RunController;

  private localPlayer: LocalPlayer | null = null;
  private localSessionId: string | null = null;

  /** Replicated figures the audio reacts to, so it reacts to CHANGES. */
  private lastLevel = -1;
  private lastRebirths = -1;
  private modelReport: PlayerModelReport | null = null;

  /**
   * The client's estimate of the server's clock.
   *
   * Advanced by the frame delta and re-based whenever a fresher `elapsed`
   * arrives. Freezing it between patches would make the sinking platforms and
   * the rolling balls stutter at the patch rate rather than run smoothly.
   */
  private worldTime = 0;
  private lastServerTime = -1;

  /** Authoritative respawn waiting for the death animation to finish. */
  private pendingRespawn: RespawnMessage | null = null;

  /** Last replicated owned-robot mask, so the stands only relight on change. */
  private lastOwnedRobots = -1;

  constructor(container: HTMLElement) {
    injectHudStyles();
    this.renderer = new RendererManager(container);
    this.remotePlayers = new RemotePlayerManager(this.sceneManager.scene);
    this.hud = new SpeedHud(container);
    this.pops = new SpeedPopups(container);
    this.wins = new WinsCounter(container);

    // The left rail. Four tiles, laid out so a fifth can be added without
    // re-spacing the others.
    this.rail = document.createElement('div');
    this.rail.className = 'aoe-rail';
    container.appendChild(this.rail);

    this.rebirthPanel = new RebirthPanel(container, () => this.network.requestRebirth());
    this.mechShop = new MechShop(container, {
      // The SAME request the display plinths send. `RobotService` cannot tell
      // the two apart and does not need to - the Wins check is the whole
      // authority, and it is the same check either way.
      buy: (slot) => this.network.claimRobot(slot),
    });
    this.trailShop = new TrailShop(container, {
      buy: (slot) => this.network.buyTrail(slot),
      equip: (slot) => this.network.equipTrail(slot),
    });

    this.rebirthButton = new RailButton(this.rail, {
      variant: 'rebirth',
      label: 'Rebirth',
      icon: ICONS.rebirth,
      hotkey: 'R',
      onClick: () => this.openOnly(this.rebirthPanel),
    });
    this.mechButton = new RailButton(this.rail, {
      variant: 'mech',
      label: 'Mechs',
      icon: ICONS.mech,
      hotkey: 'B',
      onClick: () => this.openOnly(this.mechShop),
    });
    this.trailButton = new RailButton(this.rail, {
      variant: 'trail',
      label: 'Trails',
      icon: ICONS.trail,
      hotkey: 'T',
      onClick: () => this.openOnly(this.trailShop),
    });
    this.audioButton = new RailButton(this.rail, {
      variant: 'audio',
      label: 'Sound',
      icon: ICONS.audio,
      hotkey: 'M',
      onClick: () => {
        // The ONE place muting happens, whether it was a click or the M key.
        const muted = this.audio.toggleMuted();
        this.audioButton.root.classList.toggle('aoe-tile--off', muted);
      },
    });

    this.playerAudio = new PlayerAudio(this.audio);

    /*
     * The portal bridge.
     *
     * Everything Bloxity can change about this game arrives through the host
     * object below, and nothing else in the codebase imports the SDK. The
     * renderer, the audio and the input layer are handed plain values and
     * never learn that a portal exists - which is what makes the whole
     * integration removable, and what keeps it working when the SDK script
     * simply is not there.
     */
    this.bloxity = new Bloxity({
      setMasterVolume: (level) => this.audio.setMasterVolume(level),
      setMusicVolume: (level) => this.audio.setMusicVolume(level),
      setGraphicsQuality: (level) => this.renderer.setQuality(level),
      setShowFps: (show) => {
        this.fpsReadout.hidden = !show;
      },
      setCameraSensitivity: (scale) => this.input.look.setSensitivityScale(scale),
      // The portal asks; the SERVER still decides where anyone is placed.
      respawn: () => this.network.requestRespawn(),
      pointerLockChanged: (locked) => this.input.look.setCursorFree(!locked),
      avatarChanged: (equipped, proportions) => {
        const look = lookFromLegion(equipped, proportions);
        // Everyone else has to see it too, so it goes on the wire as well as
        // onto the local rider. Sanitising is the SERVER's job; this sends
        // what the portal reported.
        this.network.sendAvatar(look);

        const apply = (): void => this.dresser?.setLook(look.appearance, look.proportions);
        // The avatar can arrive before the bundled model has finished loading.
        if (this.dresser) apply();
        else this.pendingAvatar = apply;
      },
    });

    this.fpsReadout = document.createElement('div');
    this.fpsReadout.className = 'aoe-fps aoe-font';
    this.fpsReadout.hidden = true;
    container.appendChild(this.fpsReadout);

    this.bloxityPanel = new BloxityPanel(container, this.bloxity);

    /*
     * There is no on-screen hint line any more.
     *
     * It existed to tell a desktop player that the rail was clickable and
     * which keys opened what. The tiles now carry their own key caps, so the
     * line was saying a second time what the buttons already say - and it was
     * the last piece of keyboard text that showed on a phone.
     */

    window.addEventListener('keydown', this.onHotkey);
    // Audio can only start on a real gesture, and no single one of them is
    // guaranteed to be the one the browser accepts - so every gesture asks,
    // and `resume` is written to be safe to call repeatedly.
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('mousedown', this.onGesture);
    window.addEventListener('touchstart', this.onGesture, { passive: true });

    this.renderer.onResize((width, height) => this.camera.setViewport(width, height));

    this.network = new NetworkClient({
      onStatusChange: (status) => this.onStatusChange(status),
      onSelfJoined: (sessionId) => {
        this.localSessionId = sessionId;
        // The room a friend would be invited INTO. Published as soon as it is
        // joinable, which is what makes an invite land beside the player
        // rather than merely in the game.
        const roomId = this.network.roomId;
        this.bloxity.updateRoom(roomId);
        this.bloxityPanel.setRoom(roomId);
      },
      onPlayerAdded: (sessionId, player) => this.onPlayerAdded(sessionId, player),
      onPlayerChanged: (sessionId, player) => this.onPlayerChanged(sessionId, player),
      onPlayerRemoved: (sessionId) => this.remotePlayers.remove(sessionId),
      onRespawn: (message) => {
        // The server's authoritative respawn. HELD rather than applied at once:
        // the client is usually mid-animation, and the whole point of the death
        // transition is that nothing moves the mount until it ends.
        // `acknowledgeRespawn` lifts the reconciliation barrier here, because
        // every patch the server sends after this message is post-respawn.
        this.pendingRespawn = message;
        this.localPlayer?.acknowledgeRespawn();
        this.applyPendingRespawn();
      },
      onStageAwarded: (message) => this.onStageAwarded(message),
    });

    // The room needs to know which Bloxity account this is, or a purchase
    // fulfilled by webhook has no profile to land in.
    this.network.setIdentityProvider(() => this.bloxity.getUser()?._id ?? null);
    // Asked for at JOIN time rather than pushed after it, so the room has this
    // player's appearance in the very first patch everyone else receives.
    this.network.setLookProvider(() =>
      lookFromLegion(this.bloxity.getEquipped(), this.bloxity.getProportions()),
    );

    this.run = new RunController(this.world.collision, {
      claimStage: (index) => {
        // Flush the pending input first: the server validates the claim against
        // the last position it has SIMULATED, so the movement that carried the
        // player onto the pad must be consumed before the request arrives.
        this.flushInput();
        this.network.claimStage(index);
      },
      claimRobot: (slot) => {
        this.flushInput();
        this.network.claimRobot(slot);
      },
      // The return pad. No position to validate, so nothing to flush - the
      // server puts the player at the spawn wherever they asked from.
      requestRespawn: () => this.network.requestRespawn(),
    });
  }

  /**
   * Keys that open the menus.
   *
   * Point 12's other half: a panel that can only be reached by clicking a
   * button the cursor cannot reach is not reachable, so there is a key for
   * each one as well. Ignored while the player is typing, and ignored with a
   * modifier held, so browser shortcuts still work.
   */
  private readonly onHotkey = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.repeat) return;
    if (isTyping(event.target)) return;

    /*
     * A key PRESSES THE BUTTON. It does not do the same thing as the button.
     *
     * `RailButton.press()` dispatches the tile's own click, so the key path and
     * the mouse path run one handler between them - and a key can never drift
     * into doing almost-but-not-quite what the tile it stands for does. The
     * mute key used to toggle the audio itself and repaint the tile by hand,
     * which is two copies of one action waiting to disagree.
     */
    switch (shortcutOf(event)) {
      case 'r':
        this.rebirthButton.press();
        break;
      case 'b':
        this.mechButton.press();
        break;
      case 't':
        this.trailButton.press();
        break;
      case 'm':
        this.audioButton.press();
        break;
      case 'escape':
        // The browser releases the lock on Escape whatever the page wants, so
        // this only closes whatever was open - `MouseLook` handles the cursor.
        for (const panel of this.panels) panel.setOpen(false);
        this.input.look.setCursorFree(true);
        // And hand ESC to the portal, which owns the pause menu when the game
        // is embedded. Standalone this is a no-op.
        this.bloxity.showPortalMenu(true);
        break;
      default:
        break;
    }
  };

  /**
   * The frame counter behind the portal's `show_fps` setting.
   *
   * Averaged over half a second rather than shown per frame: a number that
   * changes sixty times a second is a number nobody can read, and the point of
   * the readout is to be readable.
   */
  private tickFps(delta: number): void {
    if (this.fpsReadout.hidden) return;
    this.fpsAccum += delta;
    this.fpsFrames += 1;
    if (this.fpsAccum < 0.5) return;
    const fps = Math.round(this.fpsFrames / this.fpsAccum);
    this.fpsReadout.textContent = `${fps} FPS`;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
  }

  /** Any real gesture is permission to start audio. */
  private readonly onGesture = (): void => {
    this.audio.resume();
  };

  /**
   * Open one panel and close the other.
   *
   * Two modals over each other is a state with no way back to the game, and
   * the rail makes it one click away.
   */
  private openOnly(panel: Panel): void {
    for (const other of this.panels) {
      if (other !== panel) other.setOpen(false);
    }
    panel.toggle();
  }

  /**
   * Every rail panel, in one list.
   *
   * A getter rather than a field so it cannot go stale, and ONE list rather
   * than three literals scattered through the class: "close the others" and
   * "close everything" were written out by hand in three places, and adding
   * the mech shop to two of them would have left Escape unable to close it.
   */
  private get panels(): readonly Panel[] {
    return [this.rebirthPanel, this.mechShop, this.trailShop];
  }

  /**
   * Bring the portal up.
   *
   * Called before anything else loads, because the loading REPORT is one of
   * the things it provides: a portal that learned about this game only once
   * the game had finished loading would have nothing to show while it did.
   */
  startBloxity(): void {
    this.bloxity.start();
  }

  /** Progress, for the portal's loading screen. */
  loadingStep(text: string): void {
    this.bloxity.loadingStep(text);
  }

  /** Load assets and build the world. Networking is started separately. */
  async initialise(): Promise<PlayerModelReport> {
    this.world.addTo(this.sceneManager.scene);

    this.modelReport = await playerModelLoader.load();

    this.localPlayer = new LocalPlayer(this.world.collision, STARTER_ROBOT_SLOT);

    // The local rider's appearance. Remote riders are dressed by the same
    // class from their replicated look, so both sides of the wire build a
    // player out of exactly one code path.
    this.dresser = new AvatarDresser(this.localPlayer.mount);
    // Anything that arrived while the bundled model was still loading.
    this.pendingAvatar?.();
    this.pendingAvatar = null;

    this.sceneManager.scene.add(this.localPlayer.mount.root);
    // The trail lives in world space, so it is added beside the mount.
    this.sceneManager.scene.add(this.localPlayer.mount.worldRoot);
    this.camera.snapTo(this.localPlayer.position);

    logger.info(SCOPE, 'world ready');
    return this.modelReport;
  }

  /** Join the Colyseus room. Rendering continues even if this fails. */
  async connect(): Promise<void> {
    await this.network.connect();
  }

  start(): void {
    this.input.attach(this.renderer.renderer.domElement);
    // The loading screen comes down and the session begins. Both are the
    // portal's to draw; this only says when.
    this.bloxity.loadingEnd();
    this.bloxity.gameplayStart();
  }

  stop(): void {
    this.input.detach();
    this.bloxity.gameplayEnd();
    // Out of the room, so a friend is not invited into a game nobody is in.
    this.bloxity.updateRoom('');
    void this.network.disconnect();
  }

  /** One simulation and render step. Called by GameLoop. */
  update(delta: number, _now: number): void {
    // A panel owns the input while it is up; closing it hands control straight
    // back on the next frame.
    this.input.setSuppressed(anyPanelOpen());
    const input = this.input.sample();
    const player = this.localPlayer;

    // The MOUSE aims the camera, and the camera defines forward. Nothing the
    // player presses rotates the view.
    this.camera.setOrbit(this.input.look.yaw, this.input.look.pitch);
    this.camera.setZoom(this.input.look.zoom);

    // The world clock, advanced locally between patches. Sinking platforms and
    // rolling balls are pure functions of it on BOTH sides, so the client has
    // to keep its own estimate rather than freezing between server updates.
    this.worldTime =
      this.network.elapsed > this.lastServerTime
        ? this.network.elapsed
        : this.worldTime + delta;
    this.lastServerTime = this.network.elapsed;
    const elapsed = this.worldTime;

    const guardian = this.network.guardian;
    if (guardian) {
      this.world.guardian.apply(
        guardian.x,
        guardian.z,
        guardian.rotationY,
        guardian.charging,
      );
    }

    if (player) {
      player.setWorldTime(elapsed);
      // Camera-relative movement: forward is whichever way the camera faces.
      // The robot's own facing then follows where it actually moves, which
      // the shared simulation does identically on both sides.
      player.update(delta, input, this.input.look.yaw);

      // Triggers are sampled after the mount has moved, so a finish pad or a
      // hazard is detected at the position actually reached this frame.
      this.run.update(delta, player, elapsed);

      // The death animation has run its course; place the player, preferring
      // the server's own transform when it has already arrived.
      if (player.deathComplete) this.applyPendingRespawn();

      // Still not placed. The prediction and the server disagreed about the
      // death, so ASK for a placement rather than sit frozen waiting for one
      // that was never coming. The server answers this the same way it answers
      // any other death - by putting the player at the spawn.
      if (player.consumeRespawnNudge()) {
        logger.warn(SCOPE, 'death was not acknowledged; requesting a respawn');
        this.network.requestRespawn();
      }

      this.snapCameraIfPlaced();
      this.camera.setTarget(player.position);
      // The win celebration rides the machine. It has to be told where that is
      // every frame, because an award TELEPORTS the player home a moment after
      // it lands - see `WinTrophies.follow`.
      this.world.winTrophies.follow(player.position);
      this.sceneManager.followShadow(
        player.position.x,
        player.position.y,
        player.position.z,
      );
      this.flushInput();
    }

    this.tickFps(delta);
    if (player) this.playerAudio.update(delta, player);
    // The boards redraw only when the standings actually move, so handing them
    // the snapshot every frame costs a string compare.
    this.world.scoreboard.update(this.network.leaderboard);
    this.pops.update(delta);
    this.world.update(delta, elapsed);
    // The closest-player rule needs the camera's own target, not the raw
    // simulation: "nearest" has to mean nearest to what is on screen.
    this.remotePlayers.advance(delta, player?.position ?? null);
    this.camera.update(delta, player?.horizontalSpeed ?? 0);

    this.renderer.renderer.render(this.sceneManager.scene, this.camera.camera);
  }

  /**
   * Hand every simulated input to the network.
   *
   * Every one must be sent: the server advances only by the inputs it
   * receives, so a dropped input is authoritative movement that never happens.
   */
  private flushInput(): void {
    const player = this.localPlayer;
    if (!player) return;
    for (const message of player.drainOutgoing()) this.network.sendInput(message);
  }

  /**
   * Apply the server's respawn, once the death animation has finished.
   *
   * Held until then on purpose: applying it mid-animation would teleport the
   * mount away from the fall the player is watching.
   */
  private applyPendingRespawn(): void {
    const player = this.localPlayer;
    const message = this.pendingRespawn;
    if (!player || !message) return;
    if (player.isDying && !player.deathComplete) return;

    this.pendingRespawn = null;
    player.teleport(message.x, message.y, message.z, message.rotationY);
  }

  /** Arrive rather than ease whenever the player was PLACED, not moved. */
  private snapCameraIfPlaced(): void {
    const player = this.localPlayer;
    if (!player) return;
    const placement = player.consumePlacement();
    if (placement === 'none') return;
    // Only a respawn is allowed to be seen. A network correction must arrive
    // invisibly, or ordinary packet loss would fire the dolly.
    this.camera.snapTo(player.position, placement === 'respawn');
  }

  private onPlayerAdded(sessionId: string, state: NetPlayerState): void {
    if (sessionId === this.localSessionId) {
      this.applyLocalState(state);
      return;
    }
    this.remotePlayers.add(sessionId, state);
    // The portal draws the "your friend just joined" toast; it only needs to
    // be told who. The session id is all this game has for a stranger, which
    // is exactly what it is - a handle, not a name it invented.
    this.bloxity.playerJoined(sessionId);
    this.bloxity.playerInRoom(sessionId);
  }

  private onPlayerChanged(sessionId: string, state: NetPlayerState): void {
    if (sessionId === this.localSessionId) {
      this.applyLocalState(state);
      return;
    }
    this.remotePlayers.update(sessionId, state);
  }

  /**
   * Everything the server says about the local player.
   *
   * The client reconciles its prediction against the transform, adopts the
   * authoritative movement profile, shows the robot it is told to show and
   * renders the progression it is told to render. It derives none of it.
   */
  private applyLocalState(state: NetPlayerState): void {
    const player = this.localPlayer;
    if (!player) return;

    player.setMovementProfile(state.moveMultiplier, state.jumpVelocity);
    player.setRobotSlot(state.robotSlot);

    if (state.ready) {
      player.reconcile({
        x: state.x,
        y: state.y,
        z: state.z,
        rotationY: state.rotationY,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        velocityZ: state.velocityZ,
        grounded: state.grounded,
        jumpCount: state.jumpCount,
        lastInputSeq: state.lastInputSeq,
        jumpLatched: state.jumpLatched,
        coyote: state.coyote,
      });
    }

    player.setTrailSlot(state.trailSlot);

    this.hud.update(state.totalSpeed, state.maxLevel);
    // The stands need the level too: a robot that is affordable and a
    // treadmill that is unlocked are the two things the shop floor shows, and
    // both are decided by figures the server sent.
    this.world.training.setLevel(state.level);
    // Only an INCREASE in the replicated total spawns a popup, so the figure
    // simply being re-sent on every patch never does.
    this.pops.observe(state.totalSpeed);
    this.wins.update(state.wins);
    this.run.setInventory(state.ownedRobots, state.wins);

    // The rail mirrors replicated state and decides nothing. A tile is "ready"
    // when the server would accept the request behind it right now.
    // Milestone sounds fire on the CHANGE, never on the value: a level is
    // re-sent on every patch, and playing on the level would be a fanfare
    // twenty times a second for as long as the player stayed at it.
    if (this.lastLevel >= 0 && state.level > this.lastLevel) this.audio.play('level');
    if (this.lastRebirths >= 0 && state.rebirths > this.lastRebirths) {
      this.audio.play('rebirth');
    }
    this.lastLevel = state.level;
    this.lastRebirths = state.rebirths;

    this.rebirthPanel.setProgress(state.level, state.rebirths);
    this.rebirthButton.setState(this.rebirthPanel.isEligible, !this.rebirthPanel.isEligible);
    this.mechShop.setInventory(state.wins, state.ownedRobots, state.robotSlot);
    this.mechButton.setState(this.mechShop.hasAffordable);
    this.trailShop.setInventory(state.wins, state.ownedTrails, state.trailSlot);
    this.trailButton.setState(this.trailShop.hasAffordable);

    if (state.ownedRobots !== this.lastOwnedRobots) {
      if (this.lastOwnedRobots !== 0) this.audio.play('claim');
      this.lastOwnedRobots = state.ownedRobots;
      this.world.stands.setOwned(state.ownedRobots);
    }
  }

  private onStageAwarded(message: StageAwardedMessage): void {
    // The counter pops from the replicated total on the next patch anyway;
    // applying it here means the reward lands on the frame it was earned
    // rather than up to a patch later.
    //
    // Trophies first, then the figure: the cups gather around the machine and
    // draw into the cockpit, in the WORLD, where the player is already looking
    // - see `WinTrophies`.
    this.launchWinTrophies(message.wins);
    this.wins.update(message.total);
    this.audio.play('win');
    logger.info(SCOPE, `stage ${message.stageIndex} banked: +${message.wins} wins`);
  }

  /**
   * Burst trophies around the pilot for ONE award.
   *
   * Called from `onStageAwarded` and nowhere else, so it fires exactly when
   * the SERVER says Wins were granted: standing on a win pad cannot retrigger
   * it, and nothing in the effect polls a position to decide whether to play.
   *
   * @param wins the figure the server awarded, which is what decides how big
   *             the celebration is
   *
   * Silent when there is no local player yet - an award cannot arrive before
   * one exists, but the effect must never be the thing that throws during a
   * reward if it somehow does.
   */
  private launchWinTrophies(wins: number): void {
    const player = this.localPlayer;
    if (!player) return;
    // Placed where the machine is NOW, and kept there by `follow` for the rest
    // of the animation - the server returns the player to the hangar on the
    // very next message.
    this.world.winTrophies.follow(player.position);
    this.world.winTrophies.play(wins);
  }

  private onStatusChange(status: ConnectionStatus): void {
    if (clientConfig.debug) logger.info(SCOPE, `connection: ${status}`);
  }

  dispose(): void {
    this.stop();
    this.hud.dispose();
    this.pops.dispose();
    this.wins.dispose();
    window.removeEventListener('keydown', this.onHotkey);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('mousedown', this.onGesture);
    window.removeEventListener('touchstart', this.onGesture);
    this.bloxity.dispose();
    this.bloxityPanel.dispose();
    this.dresser?.dispose();
    this.fpsReadout.remove();
    this.audio.dispose();
    this.rebirthButton.dispose();
    this.trailButton.dispose();
    this.audioButton.dispose();
    this.rebirthPanel.dispose();
    this.mechShop.dispose();
    this.trailShop.dispose();
    this.rail.remove();
    this.remotePlayers.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
