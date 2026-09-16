import { DEFAULT_SERVER_PORT } from '@robot/shared';

/** Runtime client configuration, overridable at build time via Vite env vars. */
export interface ClientConfig {
  /** Colyseus endpoint, e.g. ws://localhost:2569 */
  readonly serverUrl: string;
  /** Verbose console diagnostics. */
  readonly debug: boolean;
  /** Cap on devicePixelRatio, to protect mobile GPUs. */
  readonly maxPixelRatio: number;
}

/** Hosts where the game server is expected to be the dev one, beside us. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Where the Colyseus server is.
 *
 * `VITE_SERVER_URL` wins, always. It is baked in at BUILD time, which is what
 * a static host needs: there is no server-side rendering step in which to
 * inject it later.
 *
 * The fallback only guesses for LOCAL development, where the dev script really
 * does put the game server on the next port along. It deliberately does NOT
 * guess for a deployed origin: Netlify and every other static host serve files
 * and nothing else, so `wss://the-site/:2569` is an address that cannot ever
 * answer - and a client pointed at one spends thirty seconds timing out
 * instead of saying what is actually wrong.
 *
 * So a deployed build with no `VITE_SERVER_URL` returns an empty string, and
 * the boot path reports a misconfiguration rather than a network failure.
 */
/**
 * Accept an http(s) address and hand back the ws(s) one.
 *
 * `VITE_SERVER_URL` is the ONE thing anyone has to set to deploy this client,
 * so it is worth it being hard to set wrongly. A host's dashboard hands out
 * `https://name.fly.dev`, that is what gets pasted in, and a Colyseus client
 * given an `https://` origin fails with a message about the socket rather than
 * about the scheme. Converting is unambiguous, so it is done rather than
 * complained about.
 */
const asWebSocketUrl = (raw: string): string => {
  const url = raw.trim().replace(/\/+$/, '');
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  return url;
};

const resolveServerUrl = (): string => {
  const fromEnv = import.meta.env['VITE_SERVER_URL'] as string | undefined;
  if (fromEnv && fromEnv.trim()) return asWebSocketUrl(fromEnv);

  const { protocol, hostname } = window.location;
  if (!LOCAL_HOSTS.has(hostname)) return '';

  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}:${DEFAULT_SERVER_PORT}`;
};

export const clientConfig: ClientConfig = {
  serverUrl: resolveServerUrl(),
  debug: import.meta.env.DEV || import.meta.env['VITE_DEBUG'] === '1',
  maxPixelRatio: 2,
};
