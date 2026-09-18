import { resolve } from 'node:path';
import { DEFAULT_SERVER_PORT, SERVER_TICK_RATE } from '@robot/shared';

/** Runtime server configuration, overridable by environment variables. */
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly tickRate: number;
  /** Milliseconds between state patches sent to clients. */
  readonly patchRateMs: number;
  /** Directory holding persisted player profiles. */
  readonly dataDir: string;
  /**
   * Shared secret for the Bloxity fulfilment webhook, or '' to accept any.
   *
   * Empty by default so a local server needs no configuration. Set it in
   * production: without one the endpoint grants Wins to anyone who finds it.
   */
  readonly buxWebhookSecret: string;
  /**
   * This game's Bloxity id - the `gameSlug` a portal token is verified
   * against. Legion injects `BLOXITY_GAME_ID` into every backend pod; the
   * fallback is this game's own slug, for a local server.
   */
  readonly bloxityGameId: string;
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * `--port N` from the command line.
 *
 * Takes precedence over `PORT`, and the dev script passes it. That order
 * matters: a dev harness that hosts the CLIENT often exports `PORT` for its
 * own web server, and without an explicit override the game server silently
 * binds to the same port - which looks like a working server and a client that
 * cannot reach it. Managed hosts have no argv to pass, so `PORT` still wins in
 * production, which is exactly where it should.
 */
const portArgument = (): string | undefined => {
  const at = process.argv.indexOf('--port');
  return at >= 0 ? process.argv[at + 1] : undefined;
};

export const serverConfig: ServerConfig = {
  port: int(portArgument() ?? process.env['PORT'], DEFAULT_SERVER_PORT),
  host: process.env['HOST'] ?? '0.0.0.0',
  tickRate: SERVER_TICK_RATE,
  patchRateMs: 1000 / SERVER_TICK_RATE,
  // Relative to the server package, which is the working directory for both
  // `npm run dev` and `npm start`, so a restart finds the same file either way.
  dataDir: resolve(process.env['ROBOT_DATA_DIR'] ?? 'data'),
  buxWebhookSecret: process.env['BLOXITY_WEBHOOK_SECRET'] ?? '',
  bloxityGameId: process.env['BLOXITY_GAME_ID']?.trim() || 'speed-robot-escape',
};
