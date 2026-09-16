/**
 * Room capacity, checked against a RUNNING server.
 *
 * The other two suites are static: they read the course data and exercise the
 * services in-process. This one cannot be, because what it is checking is the
 * matchmaker - the thing that decides which room a connecting player lands in,
 * and which only exists once a server is actually listening.
 *
 * It connects more clients than one room may hold and asserts three things:
 *
 *   - no room ever holds more than `MAX_PLAYERS_PER_ROOM`
 *   - the overflow is ROUTED to another room rather than refused
 *   - every room CLOSES ITSELF once its last player leaves
 *
 * All three matter. A limit that turned the sixteenth player away would be a
 * limit that closes the game to them; a limit that let them in anyway would
 * not be a limit at all; and a room that outlived its last player would leak a
 * simulation loop apiece on a server that has been up for a week.
 *
 * Usage: start the server, then `npm run verify:capacity`.
 *        ENDPOINT=wss://your-host npm run verify:capacity  to check a deployment.
 */
import { Client } from 'colyseus.js';
import { MAX_PLAYERS_PER_ROOM, ROOM_NAME } from '../shared/dist/index.js';

const ENDPOINT = process.env.ENDPOINT ?? 'ws://localhost:2573';
/** Enough over the line to prove routing, few enough to stay quick. */
const TOTAL = MAX_PLAYERS_PER_ROOM + 3;

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

console.log(`room capacity (${ENDPOINT})`);

const rooms = new Map();
const joined = [];
let refused = 0;

for (let i = 0; i < TOTAL; i += 1) {
  const client = new Client(ENDPOINT);
  try {
    // The same call the game client makes. Testing a different join path would
    // prove something about a path no player ever takes.
    const room = await client.joinOrCreate(ROOM_NAME, { playerId: `capacity-probe-${i}` });
    joined.push(room);
    rooms.set(room.roomId, (rooms.get(room.roomId) ?? 0) + 1);
  } catch (error) {
    refused += 1;
    console.log(`        client ${i} refused: ${error?.message ?? error}`);
  }
}

const counts = [...rooms.values()];
const biggest = counts.length > 0 ? Math.max(...counts) : 0;

if (joined.length !== TOTAL) {
  fail(`${refused} of ${TOTAL} clients could not join at all`);
} else {
  pass(`all ${TOTAL} clients were placed`);
}

if (biggest > MAX_PLAYERS_PER_ROOM) {
  fail(`a room held ${biggest}, over the limit of ${MAX_PLAYERS_PER_ROOM}`);
} else {
  pass(`no room exceeded ${MAX_PLAYERS_PER_ROOM} (fullest held ${biggest})`);
}

if (rooms.size > 1) {
  pass(`overflow routed across ${rooms.size} rooms`);
} else {
  fail(`all ${joined.length} clients landed in one room; nothing was routed`);
}

for (const [id, count] of rooms) console.log(`        room ${id}: ${count}`);

const roomIds = [...rooms.keys()];

for (const room of joined) {
  try {
    await room.leave(true);
  } catch {
    /* the room may already be gone; nothing to clean up */
  }
}

/*
 * THE EMPTY-ROOM CHECK.
 *
 * Every client has now left, so every room the run created should have
 * disposed itself. Asked of the MATCHMAKER rather than of the process: a
 * disposed room is deregistered, so it stops being listed, and that is
 * precisely the observable behaviour the requirement is about.
 *
 * The pause is for the leave to finish its round trip and the dispose to run;
 * without it the assertion races the thing it is asserting.
 */
await new Promise((resolve) => setTimeout(resolve, 1200));
{
  /*
   * Asked of the SERVER's own health probe.
   *
   * `/health` reports the matchmaker's live room count, which is the only
   * outside view of whether a room still exists - and it is the matchmaker's
   * own tally rather than a second one kept beside it, so it cannot disagree
   * with the thing it is reporting on.
   */
  const http = ENDPOINT.replace(/^ws/, 'http');
  let health = null;
  try {
    const response = await fetch(`${http}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (error) {
    fail(`could not read /health: ${error?.message ?? error}`);
  }

  if (health === null) {
    // Already reported. Nothing more to say, and NOT a pass.
  } else if (health.rooms > 0) {
    fail(
      `${health.rooms} room(s) still live after every player left ` +
        `(${health.players} player(s) in them)`,
    );
  } else {
    pass(`all ${roomIds.length} room(s) closed once empty`);
  }
}

console.log('');
console.log(failures === 0 ? 'capacity OK' : `${failures} problem(s) found`);
process.exit(failures === 0 ? 0 : 1);
