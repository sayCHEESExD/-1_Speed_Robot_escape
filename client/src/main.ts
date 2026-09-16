import { clientConfig } from './config/clientConfig.js';
import { Game } from './core/Game.js';
import { GameLoop } from './core/GameLoop.js';
import { logger } from './util/logger.js';

const SCOPE = 'main';

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');

const setBootStatus = (text: string): void => {
  if (bootStatus) bootStatus.textContent = text;
};

const showBootError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(SCOPE, message, error);
  if (!bootStatus) return;
  bootStatus.className = 'err';
  bootStatus.textContent = `Failed to start:\n${message}`;
};

/**
 * Hand the browser a frame.
 *
 * `requestAnimationFrame` rather than a zero timeout, because what is wanted
 * here is specifically a PAINT: the next line of work blocks the main thread
 * for long enough to matter on a phone, and a status nobody ever saw is worse
 * than no status at all.
 */
const paint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const main = async (): Promise<void> => {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing from index.html');

  /*
   * THE SCREEN GETS TO PAINT BEFORE THE LONG BITS RUN.
   *
   * Building the facility is a couple of hundred milliseconds of synchronous
   * geometry on a desktop and several times that on a phone, and it used to
   * run inside `new Game(...)` BEFORE anything had told the player the game
   * was starting - so the whole of it was a frozen, blank tab. Nothing here is
   * faster than it was; it is that each step now says what it is doing and
   * then yields long enough for that to reach the screen, so a slow phone
   * looks like a slow load instead of a hung browser.
   */
  setBootStatus('Building the facility…');
  await paint();

  const game = new Game(container);
  // Before anything loads: the portal draws the loading screen these steps
  // fill in, so it has to be listening before there is anything to report.
  game.startBloxity();

  setBootStatus('Loading rider…');
  game.loadingStep('Loading rider…');
  await paint();
  await game.initialise();

  setBootStatus('Connecting to server…');
  game.loadingStep('Connecting to server…');
  await paint();
  let online = true;
  try {
    await game.connect();
  } catch (error) {
    // Rendering and local movement must still work with the server down, so a
    // failed join is reported but never blocks the game from starting.
    online = false;
    showOfflineNotice(error);
  }

  game.start();
  const loop = new GameLoop((delta, now) => game.update(delta, now));
  loop.start();

  if (clientConfig.debug) {
    // Dev-only handle: lets the game be stepped by hand from the console or by
    // an automated browser check, where requestAnimationFrame is throttled.
    (window as Window & { __robot?: DebugHandle }).__robot = { game, loop };
  }

  // Hidden only on a REAL join. Speed, levels, Wins and robots are all
  // server-authoritative, so an offline session renders and moves but can
  // never progress - hiding that failure makes a broken deployment look like
  // broken gameplay.
  if (boot && online) boot.hidden = true;
  logger.info(SCOPE, 'running');
};

/**
 * Turn the boot panel into a persistent corner notice.
 *
 * The game stays playable - that is deliberate - but the player is told the
 * session is not connected, because every system they are about to find dead
 * is server-owned.
 */
const showOfflineNotice = (error: unknown): void => {
  const detail = error instanceof Error ? error.message : String(error);
  logger.error(SCOPE, `offline: ${detail}`);
  if (bootStatus) {
    bootStatus.className = 'err';
    // An empty server URL is not a network failure, it is a build that was
    // never told where the server is - which on a static host is the likeliest
    // cause by far, and the one a "cannot connect" message sends people
    // looking in entirely the wrong place.
    bootStatus.textContent = clientConfig.serverUrl
      ? `Not connected to the game server (${clientConfig.serverUrl}).\n` +
        'Playing offline: Speed, levels, Wins and robots are server-owned and ' +
        'will not progress. Reload to try again.'
      : 'This build has no game server configured (VITE_SERVER_URL was not set ' +
        'when it was built).\nPlaying offline: Speed, levels, Wins and robots ' +
        'are server-owned and will not progress.';
  }
  boot?.classList.add('notice');
};

/** Shape of the dev-only `window.__robot` handle. */
interface DebugHandle {
  game: Game;
  loop: GameLoop;
}

/*
 * Dev only: force a full reload instead of a hot swap.
 *
 * The game owns a WebGL context, a Colyseus room, a rAF loop and a global
 * model-loader singleton. Hot-swapping a module underneath all that leaves two
 * of everything - two rooms joined, two loops rendering, and a second `Game`
 * calling `createInstance()` on a loader whose promise belongs to the first.
 * A reload is the only correct response to a source change here.
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

main().catch(showBootError);
