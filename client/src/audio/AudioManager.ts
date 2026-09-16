import { logger } from '../util/logger.js';

const SCOPE = 'audio';

/** Master volumes per category. Music sits well under the gameplay sounds. */
const MUSIC_GAIN = 0.55;
const SFX_GAIN = 0.34;

/*
 * FOUR SUPPLIED FILES, and everything else synthesised.
 *
 * The asset set for this game ships a background track, a jump, a fall and a
 * mech footstep, and those four are used as they are - a tune, a real impact
 * and a servo-driven foot hitting deck plate are the things an oscillator
 * cannot fake convincingly. Everything else below is still built from
 * oscillators and envelopes, which costs bytes measured in hundreds against a
 * 12 MB budget; a full pack of wavs is the easiest way to spend that budget on
 * nothing.
 *
 * The TRACK is streamed through an `<audio>` element rather than decoded into
 * a buffer: `decodeAudioData` would hold a two-minute stereo file as tens of
 * megabytes of uncompressed samples for something only ever played end to end.
 * It still routes through `musicBus`, which is what keeps the portal's
 * `music_volume`, the master volume and mute all working on it untouched.
 *
 * Check `npm run size:client` after changing any of the three.
 */

/** The supplied background track. Streamed, never decoded. */
const MUSIC_URL = '/audio/background.mp3';

/**
 * The supplied one-shots, by the sound they stand in for.
 *
 * `fall.mp3` is the DEATH, which is what falling is in this game: every death
 * on this course is arriving somewhere the course did not want you.
 *
 * `robot steps.mp3` is the FOOTFALL, and it is the sound the player hears more
 * than any other - one per stride, for as long as they are walking. The URL is
 * percent-encoded because the supplied file has a space in its name and the
 * supplied files are never renamed; `encodeURI` would be wrong here, since it
 * leaves an existing `%` alone and this path is written out once.
 */
const SAMPLE_URLS: Partial<Record<SoundName, string>> = {
  jump: '/audio/jump.mp3',
  death: '/audio/fall.mp3',
  step: '/audio/robot%20steps.mp3',
};

/**
 * Most one-shot voices allowed to sound at once.
 *
 * A ceiling rather than a hope. Web Audio nodes are one-shot by design - a
 * source cannot be replayed, so every sound is a new node - and the thing that
 * has to be bounded is therefore how many are alive at any moment, not how
 * many are ever made. Beyond this, a request is dropped rather than queued:
 * the twelfth simultaneous footfall is inaudible anyway.
 */
const MAX_VOICES = 12;

/** Keep a slider inside 0..1 whatever the portal sent. */
const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;

/** Seconds a given sound refuses to retrigger, so nothing can machine-gun. */
const COOLDOWNS: Readonly<Record<SoundName, number>> = {
  jump: 0.12,
  land: 0.14,
  step: 0.12,
  death: 0.6,
  win: 0.4,
  level: 0.4,
  rebirth: 0.8,
  claim: 0.3,
};

export type SoundName =
  /** The leap: the frame the mech pushes off the deck. */
  | 'jump'
  /** Touchdown - the heavy one. */
  | 'land'
  /** One FOOTFALL of the walk cycle. */
  | 'step'
  | 'death'
  | 'win'
  | 'level'
  | 'rebirth'
  | 'claim';

/**
 * Every sound in the game, synthesised.
 *
 * EVERY sound is synthesised - oscillators and envelopes cost bytes measured
 * in the hundreds, and a pack of wavs is the easiest way to spend the 12 MB
 * budget. There is no music and there are no samples: this build ships not one
 * audio file.
 *
 * THREE rules hold the whole thing together:
 *
 *  - ONE context, ONE music voice. The `started` flag and the single
 *    `startMusic` call are what make a doubled track impossible rather than
 *    merely unlikely.
 *  - ONE-SHOTS ARE BOUNDED, twice: a per-sound cooldown stops the same effect
 *    retriggering every frame, and a hard voice ceiling stops the mix from
 *    ever containing more than a dozen of them.
 *  - ONLY THE LOCAL PLAYER makes noise. A busy room would otherwise put the
 *    footfalls, the leaps and the deaths of every other pilot into a mix the
 *    player is trying to hear their own machine in.
 *
 * Nothing here starts until the player's first gesture: browsers refuse to run
 * an AudioContext before one, and a context created earlier merely sits
 * suspended and confuses everything downstream.
 */
export class AudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;

  /** Live one-shot voices, so the ceiling can be enforced. */
  private voices = 0;
  /** Wall-clock of the last play, per sound. */
  private readonly lastPlayed = new Map<SoundName, number>();

  /**
   * The music, as a streaming element rather than a decoded buffer.
   *
   * `decodeAudioData` would hold the whole track in memory uncompressed - a
   * three-minute stereo file is over thirty megabytes once decoded, for
   * something that is only ever played start to finish. An element streams it,
   * loops it natively, and still routes through Web Audio, which is what keeps
   * the portal's music slider and the mute working.
   */
  private musicElement: HTMLAudioElement | null = null;
  private musicSource: MediaElementAudioSourceNode | null = null;

  /**
   * Decoded one-shot samples, by name.
   *
   * A sound is only in here once it has actually decoded, which is what makes
   * the fallback in `play` a simple lookup: until then - and for ever, if the
   * file is missing or the fetch is blocked - the synthesised voice is used
   * instead, so a blocked asset is a different sound rather than silence.
   */
  private readonly samples = new Map<SoundName, AudioBuffer>();
  /** Set once the fetches have been kicked off, so they happen exactly once. */
  private samplesRequested = false;

  /**
   * The sampled sound currently playing, per name. At most ONE each.
   *
   * The cooldowns were tuned against the synthesised voices, every one of which
   * was SHORTER than its own cooldown - the death lasted 0.5s behind a 0.6s
   * cooldown - so a one-shot could never catch its own tail. The recorded files
   * are far longer (both about 1.8s), which quietly breaks that: two deaths
   * 0.7s apart would clear the cooldown and sound on top of each other, and
   * jumps would stack until they hit the voice ceiling.
   *
   * So a sampled sound REPLACES itself rather than layering. The trigger and
   * the gain are untouched - every jump still plays the jump - it simply
   * restarts instead of doubling, which is what keeps "no overlapping deaths"
   * true now that the sound outlasts its cooldown.
   */
  private readonly activeSamples = new Map<SoundName, AudioBufferSourceNode>();

  /**
   * THE WALKING LOOP, and it is a loop rather than a one-shot per stride.
   *
   * The supplied `robot steps.mp3` is nearly three seconds of a mech WALKING -
   * several footfalls, not one - so firing it on every stride would restart it
   * before it had played its first step and the mech would sound like it was
   * stuttering on one foot. Looped instead, with its playback rate tied to the
   * pace, it is what it was recorded as: the sound of the machine walking, for
   * as long as the machine is walking.
   *
   * It is deliberately NOT counted against `voices`. That ceiling exists to
   * bound how many one-shots can pile up; this is one node whose lifetime is
   * "while the player is moving", and letting it be dropped by a busy moment
   * would silence the feet for the rest of the walk.
   */
  private footsteps: AudioBufferSourceNode | null = null;
  private footstepGain: GainNode | null = null;

  private muted = false;
  private started = false;

  /** The portal's master and music sliders, 0..1. Both default to full. */
  private masterLevel = 1;
  private musicLevel = 1;

  /**
   * Bring the audio up, on a real user gesture.
   *
   * Safe to call repeatedly - it is wired to every gesture precisely because
   * no single one of them is guaranteed to be the one the browser accepts.
   */
  resume(): void {
    if (this.muted) return;
    if (!this.context) {
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) return;
        this.context = new Ctor();
      } catch (error) {
        logger.warn(SCOPE, `no audio context: ${String(error)}`);
        return;
      }

      this.master = this.context.createGain();
      // Built at the level the portal has ALREADY set: settings arrive before
      // the first user gesture, so a context created at full volume would be
      // loud for exactly as long as it took the next slider change to arrive.
      this.master.gain.value = this.muted ? 0 : this.masterLevel;
      this.master.connect(this.context.destination);

      this.musicBus = this.context.createGain();
      this.musicBus.gain.value = MUSIC_GAIN * this.musicLevel;
      this.musicBus.connect(this.master);

      this.sfxBus = this.context.createGain();
      this.sfxBus.gain.value = SFX_GAIN;
      this.sfxBus.connect(this.master);
    }

    void this.context.resume().catch(() => undefined);

    if (!this.started) {
      this.started = true;
      this.startMusic();
      this.loadSamples();
      logger.info(SCOPE, 'audio started');
    }

    // A tab that was backgrounded pauses the element; resuming has to restart
    // it, and `play()` on an already-playing element is a no-op.
    if (this.musicElement && !this.muted) {
      void this.musicElement.play().catch(() => undefined);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Silence everything, or bring it back. The music keeps its own time. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    // The loop is the one voice that would otherwise keep running: master gain
    // silences it, but a muted game should not be holding a source open.
    if (muted) this.stopFootsteps();
    this.applyMaster();
  }

  /**
   * The portal's master volume, 0..1.
   *
   * Kept SEPARATE from mute rather than folded into it: they are two different
   * statements - "I set this to 30%" and "silence, now" - and a mute that
   * overwrote the level would hand back the wrong one when it lifted. The
   * master gain is the product of the two, so unmuting restores whatever the
   * slider said.
   */
  setMasterVolume(level: number): void {
    this.masterLevel = clamp01(level);
    this.applyMaster();
  }

  /** The portal's music volume, 0..1, against the game's own tuned mix. */
  setMusicVolume(level: number): void {
    this.musicLevel = clamp01(level);
    if (this.musicBus && this.context) {
      this.musicBus.gain.setTargetAtTime(
        MUSIC_GAIN * this.musicLevel,
        this.context.currentTime,
        0.05,
      );
    }
  }

  private applyMaster(): void {
    if (this.master && this.context) {
      const target = this.muted ? 0 : this.masterLevel;
      this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.05);
    }

    // A muted stream is PAUSED, not merely silenced. Leaving it running would
    // keep decoding a file nobody can hear, and on a phone that is battery
    // spent on nothing.
    const element = this.musicElement;
    if (!element) return;
    if (this.muted) element.pause();
    else void element.play().catch(() => undefined);
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Play a one-shot.
   *
   * Refused if the same sound played within its cooldown, or if the voice
   * ceiling is already reached. Both refusals are silent: a sound that cannot
   * be heard is not an error.
   */
  /**
   * Drive the walking loop.
   *
   * @param active true while the mech is on the ground and actually moving
   * @param pace   0..1, how fast it is going as a fraction of its own top
   * @returns false when there is no recording to play, so the caller can fall
   *          back to the synthesised per-stride footfall instead
   *
   * Called every frame. Starting, stopping and re-rating are all idempotent,
   * because the caller has no business tracking which of those it did last.
   */
  setFootsteps(active: boolean, pace: number): boolean {
    const ctx = this.context;
    const bus = this.sfxBus;
    const buffer = this.samples.get('step');
    if (!ctx || !bus || !buffer) {
      this.stopFootsteps();
      return false;
    }
    if (!active || this.muted || ctx.state !== 'running') {
      this.stopFootsteps();
      return true;
    }

    if (!this.footsteps || !this.footstepGain) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const envelope = ctx.createGain();
      // From silence, so setting off never begins with a click.
      envelope.gain.value = 0;
      source.connect(envelope);
      envelope.connect(bus);
      source.start();
      this.footsteps = source;
      this.footstepGain = envelope;
    }

    /*
     * Pace changes the RATE, within a band a recording can be stretched over
     * without sounding like a different machine.
     *
     * The same reasoning as the animation's cadence clamp: a late-game mech
     * covers four hundred units a second and an unclamped cadence is a tone
     * rather than a walk. The sense of speed comes from the world going past.
     */
    const level = clamp01(pace);
    const now = ctx.currentTime;
    // Under 1 across the whole band: the recording's own cadence is quicker
    // than this mech's, and the gait it has to agree with is a slow one.
    this.footsteps.playbackRate.setTargetAtTime(0.6 + level * 0.35, now, 0.08);
    this.footstepGain.gain.setTargetAtTime(0.4 + level * 0.35, now, 0.05);
    return true;
  }

  /** Stop the walking loop, fading out so it does not click. */
  private stopFootsteps(): void {
    const source = this.footsteps;
    const envelope = this.footstepGain;
    this.footsteps = null;
    this.footstepGain = null;
    if (!source) return;
    const ctx = this.context;
    if (envelope && ctx) {
      const now = ctx.currentTime;
      envelope.gain.cancelScheduledValues(now);
      envelope.gain.setValueAtTime(envelope.gain.value, now);
      envelope.gain.linearRampToValueAtTime(0, now + 0.06);
      try {
        source.stop(now + 0.08);
      } catch {
        // Already stopped; nothing to do.
      }
      return;
    }
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }

  play(name: SoundName, intensity = 1): void {
    const ctx = this.context;
    const bus = this.sfxBus;
    if (!ctx || !bus || this.muted || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const last = this.lastPlayed.get(name) ?? -Infinity;
    if (now - last < COOLDOWNS[name]) return;
    if (this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(name, now);

    const level = Math.min(Math.max(intensity, 0), 1);
    switch (name) {
      case 'jump':
        // THE LEAP. The supplied recording, falling back to a rising sweep -
        // pitch going up being the most direct way a sound can say "up".
        if (this.playSample('jump', now, 0.5 * level)) break;
        this.blip(now, 'square', 300, 720, 0.18, 0.5 * level);
        break;
      case 'land':
        this.thud(now, 0.35 + level * 0.3);
        break;
      case 'step':
        /*
         * ONE FOOTFALL, on every stride of the walk cycle.
         *
         * THE FALLBACK ONLY. The recording is played by `setFootsteps` as a
         * loop, because it is three seconds of walking rather than one step;
         * this is the synthesised stand-in for when that file is missing or
         * blocked, and the two are mutually exclusive by construction - the
         * caller only counts strides when the loop says it has nothing.
         *
         * A short low thud, and LOW is the point: this is two tons of machine
         * putting a foot down, not a person walking.
         */
        this.thud(now, 0.1 + level * 0.16, 105);
        break;
      case 'death':
        // The supplied fall, falling back to the descending sawtooth.
        if (this.playSample('death', now, 0.6)) break;
        this.blip(now, 'sawtooth', 300, 70, 0.5, 0.6);
        break;
      case 'win':
        this.arpeggio(now, [0, 4, 7, 12], 0.09, 'triangle', 0.5);
        break;
      case 'level':
        this.arpeggio(now, [0, 7, 12], 0.07, 'triangle', 0.4);
        break;
      case 'rebirth':
        this.arpeggio(now, [0, 4, 7, 12, 16, 19], 0.08, 'sawtooth', 0.45);
        break;
      case 'claim':
        this.arpeggio(now, [0, 5, 9], 0.06, 'square', 0.35);
        break;
    }
  }

  dispose(): void {
    if (this.musicElement) {
      this.musicElement.pause();
      // Dropping the src releases the network request and the decoder; an
      // element left holding a stream keeps both alive after the game is gone.
      this.musicElement.removeAttribute('src');
      this.musicElement.load();
    }
    this.musicSource?.disconnect();
    this.musicSource = null;
    this.musicElement = null;
    this.samples.clear();
    this.activeSamples.clear();
    this.samplesRequested = false;
    this.started = false;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.musicBus = null;
    this.stopFootsteps();
    this.sfxBus = null;
  }

  // -------------------------------------------------------------- the music

  /**
   * Start the background track.
   *
   * Called exactly once, from behind the `started` flag, which is what makes a
   * doubled tune impossible rather than merely unlikely. A failure here is
   * SILENT on purpose: a blocked or missing track is a game without music, not
   * a game that stops.
   */
  private startMusic(): void {
    const ctx = this.context;
    const bus = this.musicBus;
    if (!ctx || !bus || this.musicElement) return;

    const element = new Audio(MUSIC_URL);
    element.loop = true;
    // Same-origin, but stated anyway: without it the element is tainted and
    // `createMediaElementSource` produces silence rather than an error.
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    this.musicElement = element;

    try {
      this.musicSource = ctx.createMediaElementSource(element);
      this.musicSource.connect(bus);
    } catch (error) {
      logger.warn(SCOPE, `music not routed: ${String(error)}`);
      this.musicElement = null;
      return;
    }

    if (!this.muted) void element.play().catch(() => undefined);
  }

  // --------------------------------------------------------- the one-shots

  /**
   * Fetch and decode the supplied one-shots.
   *
   * Fire and forget, and every failure is swallowed: a sample that does not
   * arrive simply never enters `samples`, and `playSample` returns false, and
   * the synthesised voice is used instead. A blocked asset is therefore a
   * DIFFERENT SOUND rather than silence, which is the whole reason the
   * fallback exists.
   *
   * Requested once, behind a flag, because `resume()` is wired to every
   * gesture and fetching the same two files on every click would be a slow
   * leak nobody would look for.
   */
  private loadSamples(): void {
    if (this.samplesRequested) return;
    this.samplesRequested = true;
    const ctx = this.context;
    if (!ctx) return;

    for (const [name, url] of Object.entries(SAMPLE_URLS)) {
      void fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((data) => (data ? ctx.decodeAudioData(data) : null))
        .then((buffer) => {
          if (buffer) this.samples.set(name as SoundName, buffer);
        })
        .catch(() => undefined);
    }
  }

  /**
   * Play a decoded sample, if one is available.
   *
   * @returns false when nothing was decoded, so the caller synthesises
   *          instead. That fallback is the whole shape of this method: a
   *          missing or blocked file changes which sound plays and nothing
   *          else.
   *
   * A sampled sound REPLACES itself rather than layering. The cooldowns are
   * tuned against the synthesised voices, every one of which is shorter than
   * its own cooldown; a recorded file need not be, so without this two of them
   * could overlap.
   */
  private playSample(name: SoundName, when: number, gain: number): boolean {
    const ctx = this.context;
    const bus = this.sfxBus;
    const buffer = this.samples.get(name);
    if (!ctx || !bus || !buffer) return false;

    this.activeSamples.get(name)?.stop();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const envelope = ctx.createGain();
    envelope.gain.value = gain;
    source.connect(envelope);
    envelope.connect(bus);

    this.voices += 1;
    this.activeSamples.set(name, source);
    source.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
      if (this.activeSamples.get(name) === source) this.activeSamples.delete(name);
    };
    source.start(when);
    return true;
  }

  private blip(
    at: number,
    shape: OscillatorType,
    from: number,
    to: number,
    length: number,
    gain: number,
  ): void {
    const ctx = this.context;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;

    const osc = ctx.createOscillator();
    osc.type = shape;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);

    osc.connect(envelope);
    envelope.connect(bus);
    this.hold(osc, envelope, at, length);
  }

  /** A push against the air: a short filtered noise burst with a low thump. */
  private thud(at: number, gain: number, frequency = 150): void {
    const ctx = this.context;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, at);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.45, at + 0.09);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);

    osc.connect(envelope);
    envelope.connect(bus);
    this.hold(osc, envelope, at, 0.12);
  }

  private arpeggio(
    at: number,
    semitones: readonly number[],
    step: number,
    shape: OscillatorType,
    gain: number,
  ): void {
    const ctx = this.context;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;

    for (let i = 0; i < semitones.length; i += 1) {
      if (this.voices >= MAX_VOICES) return;
      const osc = ctx.createOscillator();
      osc.type = shape;
      osc.frequency.value = 440 * 2 ** ((semitones[i] as number) / 12);

      const start = at + i * step;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(gain, start + 0.01);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + step * 2.2);

      osc.connect(envelope);
      envelope.connect(bus);
      this.hold(osc, envelope, start, step * 2.2);
    }
  }

  /**
   * Start a voice, count it, and make sure it is uncounted exactly once.
   *
   * The counting is the whole reason `MAX_VOICES` means anything: a node that
   * started without being counted, or one that ended without being uncounted,
   * would leave the ceiling either useless or permanently closed.
   */
  private hold(
    osc: AudioScheduledSourceNode,
    envelope: GainNode,
    at: number,
    length: number,
    onDone?: () => void,
  ): void {
    this.voices += 1;
    osc.start(at);
    osc.stop(at + length + 0.02);
    osc.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
      osc.disconnect();
      envelope.disconnect();
      onDone?.();
    };
  }
}
