import { createHash } from 'node:crypto';
import { serverConfig } from '../config/serverConfig.js';
import { logger } from '../util/logger.js';

const SCOPE = 'auth';

/**
 * Bloxity's own token check - the route its SDK uses to validate the token it
 * holds. A CONSTANT, not configuration: an environment variable here would be
 * one setting away from a server that trusts whatever host it is pointed at.
 */
const VERIFY_URL = 'https://api.bloxity.io/v1/auth/game-token/verify';

/** How long one verify may take before it counts as "unavailable". */
const VERIFY_TIMEOUT_MS = 4000;

/** Longest a verified token is trusted without asking again. Capped at `exp`. */
const VERIFIED_TTL_MS = 5 * 60_000;

/** How long a REJECTED token is remembered, so a bad client cannot hammer Bloxity. */
const REJECTED_TTL_MS = 30_000;

/** A portal token is a JWT; anything longer than this is not one. */
const MAX_TOKEN_LENGTH = 8192;

/**
 * The answer, in THREE outcomes rather than two.
 *
 *  - `verified`: Bloxity vouched for the token and named the account.
 *  - `rejected`: Bloxity said no. The player plays as a guest.
 *  - `unavailable`: Bloxity could not be asked - a timeout, a 5xx, a network
 *    failure. The player ALSO plays as a guest, but only for now: the session
 *    re-asks on a backoff and becomes the account the moment it can. Treating
 *    an outage as a rejection would quietly demote every signed-in player to
 *    a fresh guest for as long as it lasted.
 */
export type Verification =
  | { readonly status: 'verified'; readonly accountId: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

interface Cached {
  readonly result: Verification;
  readonly expires: number;
}

/**
 * Server-side proof of who a player is.
 *
 * The client sends the portal's TOKEN, never an account id, and this asks
 * Bloxity what it means. Nothing is verified locally: the token is Bloxity's,
 * signed with Bloxity's key, and `JWT_SECRET` in this pod is the GAME's secret,
 * not theirs - a local check against it would accept tokens Bloxity never
 * issued. The only thing read out of the token itself is `exp`, and only ever
 * to SHORTEN how long a verification is cached.
 *
 * FAIL CLOSED: an account is granted only for a 2xx whose body carries a
 * non-empty string `_id`. Every other shape is a guest.
 */
class BloxityAuth {
  private readonly cache = new Map<string, Cached>();
  /** One request per token at a time; concurrent joins share it. */
  private readonly inflight = new Map<string, Promise<Verification>>();

  async verify(token: unknown): Promise<Verification> {
    if (typeof token !== 'string' || token.length === 0) {
      return { status: 'rejected', reason: 'no token' };
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      return { status: 'rejected', reason: 'token too long' };
    }

    const key = createHash('sha256').update(token).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (cached) this.cache.delete(key);

    const running = this.inflight.get(key);
    if (running) return running;

    const request = this.ask(token).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    const result = await request;
    this.remember(key, token, result);
    return result;
  }

  private async ask(token: string): Promise<Verification> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERIFY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameSlug: serverConfig.bloxityGameId }),
        signal: abort.signal,
      });
    } catch (error) {
      const reason = abort.signal.aborted ? 'timed out' : describe(error);
      logger.warn(SCOPE, `Bloxity verify unavailable: ${reason}`);
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'rejected', reason: `HTTP ${response.status} ${await errorCode(response)}` };
    }
    if (!response.ok) {
      // A 5xx or a 429 is Bloxity being unwell. Any other 4xx is more likely
      // THIS integration being wrong than the token being bad, so it is
      // retried rather than cached as a verdict - and logged loudly.
      const reason = `HTTP ${response.status} ${await errorCode(response)}`;
      const loud = response.status >= 400 && response.status < 500 && response.status !== 429;
      if (loud) logger.error(SCOPE, `Bloxity verify answered ${reason}: check the request`);
      else logger.warn(SCOPE, `Bloxity verify unavailable: ${reason}`);
      return { status: 'unavailable', reason };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      logger.error(SCOPE, 'Bloxity verify returned 2xx with an unreadable body');
      return { status: 'unavailable', reason: 'unreadable 2xx body' };
    }
    // The SDK's own reading of this reply: `{ user }`, or the user itself.
    const user =
      payload && typeof payload === 'object' && 'user' in payload && (payload as { user?: unknown }).user
        ? (payload as { user: unknown }).user
        : payload;
    const id =
      user && typeof user === 'object' ? (user as { _id?: unknown })._id : undefined;
    if (typeof id !== 'string' || id.trim().length === 0) {
      // Fail closed. A success with no account in it is not a login.
      logger.error(SCOPE, 'Bloxity verify returned 2xx without a string _id; treating as unavailable');
      return { status: 'unavailable', reason: '2xx without _id' };
    }
    return { status: 'verified', accountId: id.trim() };
  }

  private remember(key: string, token: string, result: Verification): void {
    const now = Date.now();
    if (result.status === 'verified') {
      const exp = tokenExpiry(token);
      const expires = Math.min(now + VERIFIED_TTL_MS, exp ?? Number.POSITIVE_INFINITY);
      if (expires > now) this.cache.set(key, { result, expires });
    } else if (result.status === 'rejected') {
      this.cache.set(key, { result, expires: now + REJECTED_TTL_MS });
    }
    // `unavailable` is NEVER cached: the next attempt must actually ask.

    // Bounded, so a flood of junk tokens cannot grow it without limit.
    if (this.cache.size > 5000) {
      for (const [entryKey, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(entryKey);
      }
    }
  }
}

/**
 * The token's `exp`, in milliseconds, or null.
 *
 * Decoded WITHOUT verifying - deliberately, and only to cap the cache. Nothing
 * trusts a claim read this way; a forged `exp` can at most make a cached
 * verification of a genuine token expire sooner.
 */
const tokenExpiry = (token: string): number | null => {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
};

const errorCode = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : '';
  } catch {
    return '';
  }
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const bloxityAuth = new BloxityAuth();
