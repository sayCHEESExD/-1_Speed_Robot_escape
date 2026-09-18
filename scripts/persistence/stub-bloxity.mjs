/**
 * A stand-in for ONE Bloxity endpoint: the game-token verify route.
 *
 * TEST ONLY. Preloaded into the BUILT server by `verify-persistence.mjs` with
 * `node --import`, so the production code under test is byte-for-byte what
 * ships - there is no test switch anywhere in `server/`. Every other request
 * the server makes goes to the real `fetch` untouched.
 *
 * Behaves the way the real route was observed to:
 *
 *  - no Bearer token                 -> 401 GAME_TOKEN_REQUIRED
 *  - a token this stub did not sign  -> 401 GAME_TOKEN_INVALID
 *  - an expired token                -> 401 GAME_TOKEN_INVALID
 *  - the WRONG gameSlug in the body  -> 404 (the route does not know the game)
 *  - a good token for the right game -> 200 { user: { _id, username } }
 *
 * Tokens are JWT-shaped - `header.payload.signature`, the signature an HMAC
 * over the first two parts with a secret only this stub and the test share -
 * so a FORGED token (right payload, wrong signature) is rejected exactly as
 * Bloxity would reject one, and the server's `exp` cache cap is exercised on
 * something with a real `exp` in it.
 *
 * The test can take the route DOWN by writing `down` into the control file
 * (the fetch then fails the way a network failure does) or `error500` (a 5xx).
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERIFY_URL = 'https://api.bloxity.io/v1/auth/game-token/verify';
const EXPECTED_SLUG = process.env.PERSISTENCE_STUB_SLUG ?? '';
const SECRET = process.env.PERSISTENCE_STUB_SECRET ?? '';
const CONTROL = process.env.PERSISTENCE_STUB_CONTROL ?? '';

if (!EXPECTED_SLUG || !SECRET) {
  throw new Error('stub-bloxity: PERSISTENCE_STUB_SLUG and PERSISTENCE_STUB_SECRET are required');
}

const realFetch = globalThis.fetch;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const mode = () => {
  if (!CONTROL) return '';
  try {
    return readFileSync(CONTROL, 'utf8').trim();
  } catch {
    return '';
  }
};

const urlOf = (input) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';

globalThis.fetch = async (input, init = {}) => {
  if (urlOf(input) !== VERIFY_URL) return realFetch(input, init);

  const state = mode();
  if (state === 'down') {
    process.stderr.write('[stub-bloxity] verify -> network failure (down)\n');
    throw new TypeError('fetch failed');
  }
  if (state === 'error500') {
    process.stderr.write('[stub-bloxity] verify -> 500\n');
    return json(500, { code: 'INTERNAL' });
  }

  const headers = new Headers(init.headers ?? {});
  const auth = headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  let slug = '';
  try {
    slug = JSON.parse(typeof init.body === 'string' ? init.body : '{}').gameSlug ?? '';
  } catch {
    slug = '';
  }

  const reply = (status, body, why) => {
    process.stderr.write(`[stub-bloxity] verify -> ${status} ${why}\n`);
    return json(status, body);
  };

  if (!token) return reply(401, { code: 'GAME_TOKEN_REQUIRED' }, 'no token');
  if (slug !== EXPECTED_SLUG) return reply(404, { code: 'GAME_NOT_FOUND' }, `wrong gameSlug "${slug}"`);

  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return reply(401, { code: 'GAME_TOKEN_INVALID' }, 'malformed');
  const expected = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  if (signature !== expected) return reply(401, { code: 'GAME_TOKEN_INVALID' }, 'bad signature');

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return reply(401, { code: 'GAME_TOKEN_INVALID' }, 'unreadable payload');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    return reply(401, { code: 'GAME_TOKEN_INVALID' }, 'expired');
  }
  return reply(
    200,
    { user: { _id: claims.sub, username: claims.name ?? claims.sub } },
    `verified ${claims.sub}`,
  );
};
