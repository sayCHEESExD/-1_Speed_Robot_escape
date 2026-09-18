import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { matchMaker } from '@colyseus/core';
import { ROOM_NAME } from '@robot/shared';
import { serverConfig } from './config/serverConfig.js';
import { buxGrants } from './progression/BuxGrants.js';
import { logger } from './util/logger.js';

const SCOPE = 'webhook';

/** Bloxity's fulfilment payload. Only the fields this game acts on. */
interface BuxWebhook {
  transactionId?: string;
  userId?: string;
  username?: string;
  gameSlug?: string;
  sku?: string;
  productName?: string;
  productPrice?: number;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

/** Read a JSON body, with a ceiling so a stuck socket cannot grow for ever. */
const readJson = async (request: IncomingMessage): Promise<BuxWebhook | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as BuxWebhook;
  } catch {
    return null;
  }
};

/**
 * A plain HTTP server for Colyseus to attach to.
 *
 * Owning it rather than letting Colyseus make its own means the same port
 * answers both the WebSocket upgrade and a `/health` probe - which is what a
 * managed host polls to decide the service is up.
 */
export const createHttpServer = (): Server =>
  createServer((request, response) => {
    if (request.url === '/health') {
      void handleHealth(response);
      return;
    }

    if (request.url === BUX_WEBHOOK_PATH && request.method === 'POST') {
      void handleBuxWebhook(request, response);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

/** Where Bloxity delivers a paid purchase. */
export const BUX_WEBHOOK_PATH = '/bloxity/bux';

/**
 * The health probe, and the ONE place a room count is observable from outside.
 *
 * A managed host polls this to decide the service is up, so the useful thing
 * to report beside "ok" is what the process is actually holding: how many
 * rooms are live and how many players are in them. That makes two facts about
 * this game checkable from outside the process rather than only by reading its
 * logs - that a room holds at most fifteen, and that an empty room CLOSES
 * ITSELF rather than lingering with a simulation loop nobody is in.
 *
 * `verify:capacity` asserts exactly that against a running server.
 *
 * The query is asked of the matchmaker rather than counted here: the
 * matchmaker is the thing that knows, and a second tally kept alongside it
 * would be a second thing to get wrong.
 */
const handleHealth = async (response: ServerResponse): Promise<void> => {
  let rooms = 0;
  let players = 0;
  try {
    const live = await matchMaker.query({ name: ROOM_NAME });
    rooms = live.length;
    for (const room of live) players += room.clients;
  } catch (error) {
    // A health endpoint that can fail is not a health endpoint. An unavailable
    // matchmaker is reported as zero rooms rather than as a 500.
    logger.warn(SCOPE, `could not count rooms: ${String(error)}`);
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ok: true, room: ROOM_NAME, rooms, players }));
};

/**
 * Fulfilment, server to server.
 *
 * The ONLY way a Bux purchase becomes something a player owns. The client's
 * `requestPurchase` result is a receipt it can show; it is not a grant, and
 * nothing in the client is trusted to say a payment happened.
 *
 * ANSWERING 2xx IS THE CONTRACT. Bloxity refunds a purchase whose webhook did
 * not succeed, so this replies 200 for anything it has safely recorded -
 * including a SKU this build does not recognise, which is far more likely to
 * be a catalogue that moved ahead of a deploy than an attack, and which a
 * refund would turn into a purchase the player made and lost.
 *
 * It replies 401 only when a configured secret does not match, and 400 only
 * when the body is not something that can be recorded at all. Both are cases
 * where a refund is the correct outcome.
 */
const handleBuxWebhook = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const reply = (status: number, body: Record<string, unknown>): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  // The secret is optional so a local server needs no configuration, but if
  // one IS configured it is enforced - a webhook that accepted anything would
  // be an endpoint that grants Wins to whoever finds it.
  const expected = serverConfig.buxWebhookSecret;
  if (expected) {
    const supplied = request.headers['x-legion-webhook-secret'];
    if (supplied !== expected) {
      logger.warn(SCOPE, 'rejected a webhook with a bad secret');
      reply(401, { ok: false, error: 'bad secret' });
      return;
    }
  }

  const body = await readJson(request);
  if (!body?.transactionId || !body.userId || !body.sku) {
    logger.warn(SCOPE, 'rejected a webhook with no transaction, user or sku');
    reply(400, { ok: false, error: 'malformed payload' });
    return;
  }

  /*
   * 2xx ONLY ONCE IT IS DURABLE.
   *
   * This used to answer 200 the moment the grant was in memory - so a restart,
   * a deploy or an idle scale-to-zero between the webhook and the buyer's next
   * join lost a purchase Bloxity had already been told was delivered. Now the
   * grant is written to the shared store first. If that fails the answer is
   * 503, and Bloxity retries: the retry is either recorded, or recognised as a
   * duplicate of a write that did land after all - so it is paid exactly once
   * either way.
   *
   * `userId` is Bloxity's own id for the buyer, from Bloxity, server to
   * server. It is the only account id this game trusts that did not come
   * through a verified token.
   */
  try {
    const outcome = await buxGrants.record(
      String(body.userId),
      String(body.transactionId),
      String(body.sku),
    );
    logger.info(
      SCOPE,
      `${outcome} ${body.sku} for ${body.username ?? body.userId} [${body.transactionId}]`,
    );
    reply(200, { ok: true, transactionId: body.transactionId });
  } catch (error) {
    logger.error(
      SCOPE,
      `could not record ${body.transactionId} durably; answering 503 so Bloxity retries: ` +
        String(error instanceof Error ? error.message : error),
    );
    reply(503, { ok: false, error: 'storage unavailable, retry' });
  }
};
