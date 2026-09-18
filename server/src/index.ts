import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@robot/shared';
import { serverConfig } from './config/serverConfig.js';
import { createHttpServer } from './httpServer.js';
import { profileStore } from './progression/ProfileStore.js';
import { CourseRoom } from './rooms/CourseRoom.js';
import { logger } from './util/logger.js';

const SCOPE = 'server';

/**
 * How long shutdown waits for queued profile writes to become durable.
 *
 * Legion gives a terminating pod minutes, not seconds; this is well inside
 * that and long enough to ride out a database failover. A write still queued
 * at the end is logged loudly - it is the only way progress can be lost, and
 * it must never be lost quietly.
 */
const FLUSH_TIMEOUT_MS = 30_000;

// Open storage. Never waits for, and never fails on, the database: a pod whose
// database is down still boots and answers /health, and refuses joins until
// the database is back.
profileStore.open();

const gameServer = new Server({
  transport: new WebSocketTransport({ server: createHttpServer() }),
  greet: false,
  /*
   * OFF, and that is load-bearing. Left on, Colyseus registers its OWN
   * SIGTERM/SIGINT handler that shuts down and calls `process.exit` - before
   * the profile writes queued by the disconnecting players have reached the
   * database. Shutdown is driven from here instead, in the right order.
   */
  gracefullyShutdown: false,
});

gameServer.define(ROOM_NAME, CourseRoom);

gameServer
  .listen(serverConfig.port, serverConfig.host)
  .then(() => {
    logger.info(
      SCOPE,
      `listening on ${serverConfig.host}:${serverConfig.port} ` +
        `room="${ROOM_NAME}" health=/health storage=${profileStore.kind}`,
    );
  })
  .catch((error: unknown) => {
    logger.error(SCOPE, 'failed to start', error);
    process.exit(1);
  });

let shuttingDown = false;

/**
 * Stop, in the only order that loses nothing:
 *
 *  1. Colyseus disconnects every client WITHOUT exiting. Each `onLeave` and
 *     `onDispose` queues that player's final save.
 *  2. The store flushes - every queued write made durable - and closes.
 *  3. Only then does the process exit.
 */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(SCOPE, `received ${signal}, shutting down`);
  try {
    await gameServer.gracefullyShutdown(false);
  } catch (error) {
    logger.error(SCOPE, 'room shutdown failed; flushing storage anyway', error);
  }
  try {
    await profileStore.shutdown(FLUSH_TIMEOUT_MS);
    logger.info(SCOPE, 'storage flushed and closed');
  } catch (error) {
    logger.error(SCOPE, 'storage shutdown failed', error);
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
