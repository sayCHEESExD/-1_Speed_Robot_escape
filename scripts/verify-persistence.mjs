/**
 * PERSISTENCE, END TO END, AGAINST THE BUILT SERVER.
 *
 * ##########################################################################
 * #                                                                        #
 * #   WARNING: WITH MONGODB_URI SET, THIS SCRIPT WIPES THAT DATABASE.      #
 * #   It calls dropDatabase() on it before AND after the run. Point it     #
 * #   ONLY at a throwaway test database - never at a channel's real one.   #
 * #                                                                        #
 * ##########################################################################
 *
 * Spawns `server/dist/index.js` - the build that ships, not the sources - as a
 * real process, joins it with real colyseus.js clients exactly as the game
 * does, and reads storage DIRECTLY (the JSON files, or the Mongo collections)
 * to check what actually became durable.
 *
 * ONE thing is stubbed: Bloxity's token-verify URL, by a module preloaded into
 * the server with `node --import scripts/persistence/stub-bloxity.mjs`. There
 * are no test switches in production code. The stub signs its own JWT-shaped
 * tokens, rejects forged ones and rejects a request carrying the wrong
 * gameSlug, so every "verified" below also proves the server sent the right
 * slug.
 *
 * Stores:
 *   - the JSON store, ALWAYS.
 *   - MongoDB when MONGODB_URI is set (the database is WIPED - see above).
 *   - MongoDB INCLUDING THE OUTAGE TESTS when MONGOD_BINARY points at a real
 *     `mongod`. The script then runs its own on a fixed port (27999) and a
 *     fixed dbPath in the temp directory, and kills it hard to simulate the
 *     database going away. Get a binary WITHOUT adding anything to this repo:
 *
 *         mkdir C:\tmp\mms && cd C:\tmp\mms && npm init -y
 *         npm install mongodb-memory-server-core@10
 *         node -e "import('mongodb-memory-server-core').then(async m => console.log(await m.MongoBinary.getPath()))"
 *
 *     and pass the printed path as MONGOD_BINARY.
 *
 * Processes are killed HARD (SIGKILL; on Windows every kill is hard anyway),
 * so a "restart" here is a crash - and the script waits for the writes it
 * expects to be durable in storage before it pulls the plug.
 *
 * Not part of `npm run verify`: it needs a free port, spawns processes and
 * takes a couple of minutes.
 *
 * Usage:
 *   npm run verify:persistence
 *   MONGOD_BINARY=/path/to/mongod npm run verify:persistence
 *   MONGODB_URI=mongodb://127.0.0.1:27017/robot_persistence_test npm run verify:persistence
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'colyseus.js';
import { MongoClient } from 'mongodb';
import { MessageType, ROOM_NAME } from '../shared/dist/index.js';

const ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_ENTRY = joinPath(ROOT, 'server', 'dist', 'index.js');
const STUB = pathToFileURL(joinPath(ROOT, 'scripts', 'persistence', 'stub-bloxity.mjs')).href;

/** Clear of every port this series of games uses (2567-2573). */
const PORT = 2591;
const MONGOD_PORT = 27999;
const SLUG = 'speed-robot-escape';
const STUB_SECRET = randomBytes(16).toString('hex');
const WEBHOOK_SECRET = 'persistence-test-webhook-secret';
const BASE = `http://127.0.0.1:${PORT}`;

// ------------------------------------------------------------------ reporting

let failures = 0;
const check = (condition, message) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
  return Boolean(condition);
};
const section = (title) => console.log(`\n  -- ${title}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` returns something truthy, or give up and return null. */
const waitFor = async (probe, timeoutMs = 10_000, everyMs = 100) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not yet
    }
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
};

// --------------------------------------------------------------------- tokens

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token the stub will vouch for, naming `accountId`. */
const mint = (accountId, secret = STUB_SECRET) => {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: accountId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: randomBytes(4).toString('hex'),
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
};

/** The right shape, the right account, the wrong signature. */
const forge = (accountId) => mint(accountId, 'not-the-real-secret');

// --------------------------------------------------------------- game server

/** Every line any server printed, for the final unhandled-error sweep. */
const everyLine = [];
const unexpectedExits = [];

class GameServer {
  constructor({ dataDir, mongoUri = '', slug = SLUG, control }) {
    this.dataDir = dataDir;
    this.mongoUri = mongoUri;
    this.slug = slug;
    this.control = control;
    this.lines = [];
    this.proc = null;
  }

  async start() {
    const env = {
      ...process.env,
      ROBOT_DATA_DIR: this.dataDir,
      BLOXITY_GAME_ID: this.slug,
      BLOXITY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PERSISTENCE_STUB_SLUG: SLUG,
      PERSISTENCE_STUB_SECRET: STUB_SECRET,
      PERSISTENCE_STUB_CONTROL: this.control,
    };
    delete env.PORT;
    if (this.mongoUri) env.MONGODB_URI = this.mongoUri;
    else delete env.MONGODB_URI;

    this.lines = [];
    this.killing = false;
    const proc = spawn(process.execPath, ['--import', STUB, SERVER_ENTRY, '--port', String(PORT)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.once('exit', (code, signal) => {
      if (!this.killing) unexpectedExits.push(`server exited on its own (code ${code}, signal ${signal})`);
    });
    const collect = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        this.lines.push(line);
        everyLine.push(line);
        if (process.env.VERBOSE) console.log(`        | ${line}`);
      }
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    const up = await waitFor(() => this.lines.some((line) => line.includes('listening on')), 20_000);
    if (!up) throw new Error(`server did not start:\n${this.lines.join('\n')}`);
  }

  /** Crash it. Callers wait for the writes they need to be durable FIRST. */
  async kill() {
    if (!this.proc) return;
    this.killing = true;
    this.proc.kill('SIGKILL');
    await this.exited;
    this.proc = null;
    await sleep(300);
  }

  mark() {
    return this.lines.length;
  }

  /** The first line after `from` matching `pattern`, or null. */
  waitLog(pattern, from = 0, timeoutMs = 10_000) {
    return waitFor(() => this.lines.slice(from).find((line) => pattern.test(line)), timeoutMs);
  }
}

// ----------------------------------------------------------------- mongod

class Mongod {
  constructor(binary, dbPath) {
    this.binary = binary;
    this.dbPath = dbPath;
    this.proc = null;
  }

  async start() {
    mkdirSync(this.dbPath, { recursive: true });
    const proc = spawn(
      this.binary,
      ['--port', String(MONGOD_PORT), '--dbpath', this.dbPath, '--bind_ip', '127.0.0.1'],
      { stdio: 'ignore' },
    );
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('exit', resolve));
    const ready = await waitFor(async () => {
      const client = new MongoClient(`mongodb://127.0.0.1:${MONGOD_PORT}`, {
        serverSelectionTimeoutMS: 1000,
      });
      try {
        await client.db('admin').command({ ping: 1 });
        return true;
      } finally {
        await client.close();
      }
    }, 60_000, 250);
    if (!ready) throw new Error('mongod did not start');
  }

  async kill() {
    if (!this.proc) return;
    this.proc.kill('SIGKILL');
    await this.exited;
    this.proc = null;
    await sleep(500);
  }
}

// ---------------------------------------------------------------- storage

/** Reads the JSON store's files straight off disk, every call. */
class JsonReader {
  constructor(dir) {
    this.dir = dir;
  }

  read(file) {
    const path = joinPath(this.dir, file);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  async profile(key) {
    return this.read('profiles.json')[key] ?? null;
  }

  async grant(transactionId) {
    return this.read('grants.json')[transactionId] ?? null;
  }

  async all() {
    return this.read('profiles.json');
  }

  async close() {}
}

/** Reads the Mongo collections directly. Reads fail while the DB is down. */
class MongoReader {
  constructor(uri) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
    this.db = this.client.db();
  }

  async profile(key) {
    const doc = await this.db.collection('profiles').findOne({ _id: key });
    if (doc) delete doc._id;
    return doc;
  }

  async grant(transactionId) {
    return this.db.collection('grants').findOne({ _id: transactionId });
  }

  async all() {
    const out = {};
    for (const doc of await this.db.collection('profiles').find({}).toArray()) {
      const { _id, ...rest } = doc;
      out[_id] = rest;
    }
    return out;
  }

  async seed(profiles) {
    await this.db.collection('profiles').insertMany(
      Object.entries(profiles).map(([key, profile]) => ({ _id: key, ...profile })),
    );
  }

  async wipe() {
    await this.db.dropDatabase();
  }

  async close() {
    await this.client.close();
  }
}

// ----------------------------------------------------------------- clients

const rooms = new Set();

const connect = async (options) => {
  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const room = await client.joinOrCreate(ROOM_NAME, options);
  room.onMessage('*', () => {}); // respawns, awards: not what is being tested
  rooms.add(room);
  room.onLeave(() => rooms.delete(room));
  const ready = await waitFor(() => room.state?.players?.get?.(room.sessionId), 5000);
  if (!ready) throw new Error('joined, but never received our own player');
  room.seq = 0;
  return room;
};

const tryConnect = async (options) => {
  try {
    return { room: await connect(options) };
  } catch (error) {
    return { error };
  }
};

const me = (room) => room.state.players.get(room.sessionId);

const leave = async (room) => {
  try {
    await room.leave(true);
  } catch {
    // already gone
  }
  rooms.delete(room);
};

/** Hold W. Walking forward is the only way Speed is earned. */
const walk = async (room, seconds) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    room.seq += 1;
    room.send(MessageType.Move, { seq: room.seq, dt: 1 / 30, moveX: 0, moveZ: 1, jump: false, cameraYaw: 0 });
    await sleep(33);
  }
  room.seq += 1;
  room.send(MessageType.Move, { seq: room.seq, dt: 1 / 30, moveX: 0, moveZ: 0, jump: false, cameraYaw: 0 });
};

const signIn = (room, token) => room.send(MessageType.SetAuthToken, { token });

const webhook = async (body, secret = WEBHOOK_SECRET) => {
  try {
    const response = await fetch(`${BASE}/bloxity/bux`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-legion-webhook-secret': secret },
      body: JSON.stringify(body),
    });
    return response.status;
  } catch {
    return 0;
  }
};

const health = async () => {
  try {
    const response = await fetch(`${BASE}/health`);
    return response.status;
  } catch {
    return 0;
  }
};

/** What the join log line says this session is. */
const joinedAs = (line) => line?.match(/ as (.+?) \((?:new|restored|migrated)\)/)?.[1] ?? '?';

// ------------------------------------------------------------------ seeds

const now = Date.now();
const profile = (fields) => ({
  totalSpeed: 0,
  wins: 0,
  ownedRobots: 1,
  rebirths: 0,
  ownedTrails: 0,
  trailSlot: 0,
  bestStage: 0,
  updatedAt: now,
  ...fields,
});

const SEED = {
  'guest-a': profile({ wins: 40, totalSpeed: 500 }),
  'bloxity:acc-victim': profile({ wins: 5000, totalSpeed: 90_000 }),
  'probe~2': profile({ wins: 10 }),
  'mig-b': profile({
    wins: 60,
    totalSpeed: 300,
    bestStage: 3,
    displayName: 'Pilot B',
    futureField: 'keep-me',
  }),
  'mig-c': profile({ wins: 45, totalSpeed: 200 }),
  'bloxity:acc-d': profile({ wins: 900, totalSpeed: 1000 }),
  'guest-d': profile({ wins: 30, totalSpeed: 100 }),
  'guest-f': profile({ wins: 12 }),
  'bloxity:acc-f': profile({ wins: 321 }),
};

/** A legacy `profiles.json` found in the data dir of a Mongo-backed pod. */
const LEGACY = {
  'legacy-1': profile({ wins: 77, totalSpeed: 700 }),
  // Already in the database with wins 40: the import must NOT touch it.
  'guest-a': profile({ wins: 1 }),
  // Reserved key space: never imported.
  'bloxity:legacy-evil': profile({ wins: 99_999 }),
};

const PROGRESS_FIELDS = ['totalSpeed', 'wins', 'ownedRobots', 'rebirths', 'ownedTrails', 'trailSlot', 'bestStage'];

// ------------------------------------------------------------------- suite

/**
 * Everything both stores must do identically.
 *
 * `ctx`: { kind, server, store, control, mongod? }
 */
const coreSuite = async (ctx) => {
  const { server, store, control } = ctx;

  section('guests keep their browser progress');
  {
    const a = await connect({ playerId: 'guest-a' });
    check(me(a).wins === 40, `guest restored from its browser id (wins ${me(a).wins})`);
    const before = me(a).totalSpeed;
    await walk(a, 2.2);
    await waitFor(() => me(a).totalSpeed > before, 3000);
    const earned = me(a).totalSpeed;
    check(earned > before, `guest earns Speed live (${before} -> ${earned})`);
    await leave(a);
    check(
      await waitFor(async () => (await store.profile('guest-a'))?.totalSpeed === earned),
      'guest progress durable under the browser id after leaving',
    );
    ctx.guestASpeed = earned;
  }

  section('nobody can claim somebody else\'s progress');
  for (const [label, options] of [
    ['browser id in the account key space', { playerId: 'bloxity:acc-victim' }],
    ['the same, upper-cased', { playerId: 'BLOXITY:acc-victim' }],
    ['a raw account id as the browser id', { playerId: 'acc-victim' }],
    ['the old account-id join option', { playerId: 'fresh-b1', bloxityId: 'acc-victim' }],
    ['a forged token for the account', { playerId: 'fresh-b2', token: forge('acc-victim') }],
    ['a browser id with the successor suffix', { playerId: 'probe~2' }],
  ]) {
    const mark = server.mark();
    const room = await connect(options);
    const line = await server.waitLog(/join \S+ as /, mark);
    check(
      me(room).wins === 0 && !/as account/.test(line ?? ''),
      `${label}: gets NOTHING (wins ${me(room).wins}, joined as ${joinedAs(line)})`,
    );
    await leave(room);
  }
  await sleep(600);
  check((await store.profile('bloxity:acc-victim'))?.wins === 5000, 'the targeted account is untouched');
  check((await store.profile('probe~2'))?.wins === 10, 'the reserved-suffix profile is untouched');

  section('first login migrates guest progress (mid-session, from LIVE state)');
  {
    const b = await connect({ playerId: 'mig-b' });
    check(me(b).wins === 60, `guest mig-b restored (wins ${me(b).wins})`);
    const before = me(b).totalSpeed;
    await walk(b, 2.2);
    await waitFor(() => me(b).totalSpeed > before, 3000);
    const live = me(b).totalSpeed;
    check(live > before, `earned live Speed that no save has seen yet (${before} -> ${live})`);

    const mark = server.mark();
    signIn(b, mint('acc-b'));
    const line = await server.waitLog(/switch \S+: .* -> account bloxity:acc-b/, mark);
    check(/migrated guest progress/.test(line ?? ''), `switched to the account in place: ${line?.split('] ')[1] ?? 'no switch'}`);
    check(await waitFor(() => me(b).wins === 60), `the account carries the guest's Wins (${me(b).wins})`);

    const account = await waitFor(() => store.profile('bloxity:acc-b'));
    const guest = await waitFor(async () => {
      const doc = await store.profile('mig-b');
      return doc?.migratedTo ? doc : null;
    });
    check(account?.migratedFrom === 'mig-b', `account records migratedFrom=${account?.migratedFrom}`);
    check((account?.totalSpeed ?? 0) >= live, `account seeded from LIVE state (Speed ${account?.totalSpeed} >= ${live})`);
    check(guest?.migratedTo === 'bloxity:acc-b', `guest copy kept, marked migratedTo=${guest?.migratedTo}`);
    check(guest?.futureField === 'keep-me', 'an unknown field on the guest profile survived');
    check(
      PROGRESS_FIELDS.every((field) => account?.[field] === guest?.[field]) && account?.bestStage === 3,
      'every progression field migrated as-is',
    );

    section('sign-out gives a FRESH guest once migrated; signing back in restores');
    let at = server.mark();
    signIn(b, '');
    const out = await server.waitLog(/switch \S+: account bloxity:acc-b -> guest mig-b~2/, at);
    check(out, `signed out to ${out?.match(/-> (.*?) level/)?.[1] ?? 'nothing'}`);
    check(await waitFor(() => me(b).wins === 0), `the fresh guest starts empty (wins ${me(b).wins})`);

    at = server.mark();
    signIn(b, mint('acc-b'));
    const back = await server.waitLog(/switch \S+: guest mig-b~2 -> account bloxity:acc-b/, at);
    check(back && !/migrated/.test(back), 'signed back in, nothing migrated from the empty guest');
    check(await waitFor(() => me(b).wins === 60), `account progress restored (wins ${me(b).wins})`);
    ctx.accBSpeed = me(b).totalSpeed;
    await leave(b);
    await waitFor(async () => (await store.profile('bloxity:acc-b'))?.totalSpeed === ctx.accBSpeed);
  }

  section('the same account from a reconnect and from another browser');
  {
    let mark = server.mark();
    const again = await connect({ playerId: 'mig-b', token: mint('acc-b') });
    let line = await server.waitLog(/join \S+ as /, mark);
    check(me(again).wins === 60 && /as account bloxity:acc-b/.test(line ?? ''), `reconnect: ${joinedAs(line)}, wins ${me(again).wins}`);
    await leave(again);

    mark = server.mark();
    const other = await connect({ playerId: 'browser-2', token: mint('acc-b') });
    line = await server.waitLog(/join \S+ as /, mark);
    check(me(other).wins === 60 && /as account bloxity:acc-b/.test(line ?? ''), `another browser: ${joinedAs(line)}, wins ${me(other).wins}`);
    await leave(other);
  }

  section('login at JOIN time migrates too');
  {
    const mark = server.mark();
    const c = await connect({ playerId: 'mig-c', token: mint('acc-c') });
    const line = await server.waitLog(/join \S+ as /, mark);
    check(/as account bloxity:acc-c \(migrated\)/.test(line ?? ''), `joined as ${joinedAs(line)} (migrated)`);
    check(me(c).wins === 45, `wins carried over (${me(c).wins})`);
    await leave(c);
    check(
      await waitFor(async () => (await store.profile('mig-c'))?.migratedTo === 'bloxity:acc-c'),
      'guest mig-c marked migrated',
    );
  }

  section('an existing account is never overwritten by browser progress');
  {
    const d = await connect({ playerId: 'guest-d' });
    check(me(d).wins === 30, `guest-d restored (wins ${me(d).wins})`);
    let mark = server.mark();
    signIn(d, mint('acc-d'));
    const line = await server.waitLog(/switch \S+: guest guest-d -> account bloxity:acc-d/, mark);
    check(line && !/migrated/.test(line), 'switched without migrating');
    check(await waitFor(() => me(d).wins === 900), `the ACCOUNT's progress wins (wins ${me(d).wins})`);
    check((await store.profile('guest-d'))?.migratedTo === undefined, 'guest-d is not marked migrated');

    mark = server.mark();
    signIn(d, '');
    await server.waitLog(/switch \S+: account bloxity:acc-d -> guest guest-d/, mark);
    check(await waitFor(() => me(d).wins === 30), `sign-out returns this browser's own progress (wins ${me(d).wins})`);
    await leave(d);
    await sleep(500);
    check((await store.profile('bloxity:acc-d'))?.wins === 900, 'account acc-d still 900 in storage');
  }

  section('Bloxity unavailable: play as guest now, become the account when it answers');
  {
    writeFileSync(control, 'down');
    const mark = server.mark();
    const f = await connect({ playerId: 'guest-f', token: mint('acc-f') });
    const line = await server.waitLog(/join \S+ as /, mark);
    check(/as guest guest-f \(bloxity unavailable\)/.test(line ?? ''), `joined as ${joinedAs(line)}`);
    check(me(f).wins === 12, `plays on this browser's progress meanwhile (wins ${me(f).wins})`);
    writeFileSync(control, '');
    const switched = await server.waitLog(/switch \S+: guest guest-f .*-> account bloxity:acc-f/, mark, 20_000);
    check(switched, 're-verified on backoff and switched to the account in place');
    check(await waitFor(() => me(f).wins === 321), `account progress applied (wins ${me(f).wins})`);
    await leave(f);
    await sleep(500);
    check((await store.profile('guest-f'))?.migratedTo === undefined, 'no migration into an account that already had progress');
  }

  section('purchases go only to the verified account, exactly once, across a restart');
  {
    check((await webhook({ transactionId: 'tx-1', userId: 'acc-e', username: 'E', sku: 'wins_small' })) === 200, 'webhook recorded (200)');
    check((await webhook({ transactionId: 'tx-1', userId: 'acc-e', username: 'E', sku: 'wins_small' })) === 200, 'a retried webhook is acknowledged (200)');
    check((await webhook({ transactionId: 'tx-x', userId: 'acc-e', sku: 'wins_small' }, 'wrong')) === 401, 'a webhook with the wrong secret is refused (401)');
    check(await store.grant('tx-1'), 'the grant is durable in storage');

    for (const [label, options] of [
      ['a guest whose browser id is the account id', { playerId: 'acc-e' }],
      ['a forged token', { playerId: 'fresh-e', token: forge('acc-e') }],
    ]) {
      const room = await connect(options);
      await sleep(1200);
      check(me(room).wins === 0, `${label} receives nothing (wins ${me(room).wins})`);
      await leave(room);
    }

    // Crash between the webhook and the buyer's join.
    await server.kill();
    await server.start();

    const e = await connect({ playerId: 'browser-e', token: mint('acc-e') });
    check(await waitFor(() => me(e).wins === 250), `delivered after a restart, once (wins ${me(e).wins})`);
    const settled = await waitFor(async () => (await store.grant('tx-1'))?.settledAt);
    check(settled, 'the grant is settled after the profile holding it was saved');
    const account = await store.profile('bloxity:acc-e');
    check(account?.wins === 250 && account?.appliedGrants?.includes('tx-1'), 'the profile holds the Wins AND the transaction id');

    check((await webhook({ transactionId: 'tx-2', userId: 'acc-e', sku: 'wins_large' })) === 200, 'a purchase while playing');
    check(await waitFor(() => me(e).wins === 1750, 20_000), `delivered live (wins ${me(e).wins})`);
    check((await webhook({ transactionId: 'tx-1', userId: 'acc-e', sku: 'wins_small' })) === 200, 'a very late retry of the first purchase');
    await leave(e);
    await waitFor(async () => (await store.profile('bloxity:acc-e'))?.wins === 1750);
    const e2 = await connect({ playerId: 'browser-e', token: mint('acc-e') });
    await sleep(1500);
    check(me(e2).wins === 1750, `nothing paid twice (wins ${me(e2).wins})`);
    await leave(e2);
  }

  section('a crash loses nothing that was saved');
  {
    await sleep(800);
    const before = await store.all();
    await server.kill();
    await server.start();
    const after = await store.all();
    const same = Object.keys(before).every((key) =>
      PROGRESS_FIELDS.every((field) => before[key]?.[field] === after[key]?.[field]),
    );
    check(same, `all ${Object.keys(before).length} stored profiles identical across the crash`);
    const a = await connect({ playerId: 'guest-a' });
    check(me(a).wins === 40 && me(a).totalSpeed === ctx.guestASpeed, `guest-a comes back intact (Speed ${me(a).totalSpeed})`);
    await leave(a);
    const b = await connect({ playerId: 'anywhere', token: mint('acc-b') });
    check(me(b).wins === 60 && me(b).totalSpeed === ctx.accBSpeed, `acc-b comes back intact (Speed ${me(b).totalSpeed})`);
    await leave(b);
  }
};

/** JSON-only: a corrupt file is moved aside, never overwritten. */
const corruptSuite = async (base) => {
  section('a corrupt profiles.json is moved aside intact, and the server still boots');
  const dir = joinPath(base, 'corrupt');
  mkdirSync(dir, { recursive: true });
  const garbage = '{"guest-z": {"wins": 5, "totalSpeed": 1 BROKEN';
  writeFileSync(joinPath(dir, 'profiles.json'), garbage);
  const server = new GameServer({ dataDir: dir, control: joinPath(base, 'control') });
  await server.start();
  const aside = readdirSync(dir).find((name) => name.startsWith('profiles.json.corrupt-'));
  check(aside && readFileSync(joinPath(dir, aside), 'utf8') === garbage, `moved to ${aside}, byte-for-byte`);
  check((await health()) === 200, '/health answers');
  const room = await connect({ playerId: 'guest-z' });
  check(me(room).wins === 0, 'joins work on the (empty) store');
  await leave(room);
  await server.kill();
};

/** JSON-only: the server sends the configured slug, and a wrong one is not a login. */
const slugSuite = async (base) => {
  section('the gameSlug is sent - a wrong one is never treated as a login');
  const dir = joinPath(base, 'slug');
  const server = new GameServer({ dataDir: dir, slug: 'some-other-game', control: joinPath(base, 'control') });
  await server.start();
  const mark = server.mark();
  const room = await connect({ playerId: 'slug-probe', token: mint('acc-slug') });
  const line = await server.waitLog(/join \S+ as /, mark);
  check(!/as account/.test(line ?? ''), `the stub refused the wrong slug; joined as ${joinedAs(line)}`);
  check(server.lines.some((l) => /check the request/.test(l)), 'the server logged it LOUDLY as an integration fault');
  await leave(room);
  await server.kill();
};

/** Mongo-only: a legacy profiles.json is imported insert-only. */
const legacySuite = async (ctx) => {
  section('legacy profiles.json import adds, never overwrites');
  const line = await ctx.server.waitLog(/legacy import/, 0, 15_000);
  check(line, `import ran: ${line?.split('] ')[1] ?? 'never'}`);
  check((await ctx.store.profile('legacy-1'))?.wins === 77, 'a missing profile was added');
  check((await ctx.store.profile('guest-a'))?.wins === 40, 'an existing profile was NOT overwritten');
  check((await ctx.store.profile('bloxity:legacy-evil')) === null, 'a key in the account space was never imported');
  const room = await connect({ playerId: 'legacy-1' });
  check(me(room).wins === 77, 'the imported player plays on their progress');
  await leave(room);
};

/** Mongo with our own mongod: the database goes away and comes back. */
const outageSuite = async (ctx) => {
  const { server, store, mongod } = ctx;

  section('database down on a LIVE session');
  const b = await connect({ playerId: 'outage-browser', token: mint('acc-b') });
  const wins = me(b).wins;
  await mongod.kill();

  check((await health()) === 200, '/health keeps answering with the database down');
  const refused = await tryConnect({ playerId: 'outage-new' });
  check(refused.error && /storage/i.test(String(refused.error?.message)), `a join is REFUSED, not let in empty (${refused.error?.message ?? 'joined!'})`);
  if (refused.room) await leave(refused.room);
  check((await webhook({ transactionId: 'tx-outage', userId: 'acc-b', sku: 'wins_small' })) === 503, 'a webhook that cannot be made durable answers 503');

  let mark = server.mark();
  signIn(b, '');
  const stayed = await server.waitLog(/switch \S+ abandoned, staying as account bloxity:acc-b/, mark, 20_000);
  check(stayed, 'a sign-out that cannot reach storage stays on the current profile');
  check(me(b).wins === wins, `and keeps playing on it (wins ${me(b).wins})`);

  const before = me(b).totalSpeed;
  await walk(b, 2.2);
  await waitFor(() => me(b).totalSpeed > before, 3000);
  const earned = me(b).totalSpeed;
  check(earned > before, `earned Speed during the outage (${before} -> ${earned})`);
  await leave(b); // queues the save; the database is still down

  section('database back');
  await mongod.start();
  const landed = await waitFor(async () => (await store.profile('bloxity:acc-b'))?.totalSpeed === earned, 60_000, 500);
  check(landed, 'the save made during the outage landed once the database was back');
  const back = await waitFor(async () => (await tryConnect({ playerId: 'outage-new' })).room, 20_000, 1000);
  check(back, 'joins are accepted again');
  if (back) await leave(back);

  section('database down at BOOT');
  await mongod.kill();
  await server.kill();
  await server.start();
  check((await health()) === 200, 'the server boots and /health answers without a database');
  const early = await tryConnect({ playerId: 'guest-a' });
  check(early.error, `joins are refused until it is up (${early.error?.message ?? 'joined!'})`);
  if (early.room) await leave(early.room);
  await mongod.start();
  const joined = await waitFor(async () => (await tryConnect({ playerId: 'guest-a' })).room, 30_000, 1000);
  check(joined && me(joined).wins === 40 && me(joined).totalSpeed === ctx.guestASpeed, `once it is, progress is intact (wins ${joined ? me(joined).wins : '-'})`);
  if (joined) await leave(joined);
};

// -------------------------------------------------------------------- main

const runStore = async (kind, { mongoUri = '', mongod = null } = {}) => {
  console.log(`\n== ${kind === 'json' ? 'JSON file store' : `MongoDB store (${mongoUri})`}`);
  const base = mkdtempSync(joinPath(tmpdir(), `robot-persistence-${kind}-`));
  const dataDir = joinPath(base, 'data');
  const control = joinPath(base, 'control');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(control, '');

  let store;
  if (kind === 'json') {
    writeFileSync(joinPath(dataDir, 'profiles.json'), JSON.stringify(SEED));
    store = new JsonReader(dataDir);
  } else {
    store = new MongoReader(mongoUri);
    await store.wipe();
    await store.seed(SEED);
    writeFileSync(joinPath(dataDir, 'profiles.json'), JSON.stringify(LEGACY));
  }

  const server = new GameServer({ dataDir, mongoUri, control });
  const ctx = { kind, server, store, control, mongod };
  try {
    await server.start();
    if (kind === 'mongo') await legacySuite(ctx);
    await coreSuite(ctx);
    if (mongod) await outageSuite(ctx);
    else if (kind === 'mongo') console.log('\n  -- SKIPPED outage tests: set MONGOD_BINARY to run them');
  } catch (error) {
    check(false, `${kind} suite crashed: ${error?.stack ?? error}`);
  } finally {
    for (const room of [...rooms]) await leave(room);
    await server.kill();
  }

  if (kind === 'json') {
    await corruptSuite(base).catch((error) => check(false, `corrupt suite crashed: ${error?.stack ?? error}`));
    await slugSuite(base).catch((error) => check(false, `slug suite crashed: ${error?.stack ?? error}`));
  }

  if (kind === 'mongo') {
    try {
      await store.wipe();
    } catch {
      // the database may already be gone
    }
  }
  await store.close();
  rmSync(base, { recursive: true, force: true });
};

if (!existsSync(SERVER_ENTRY)) {
  console.error(`No build at ${SERVER_ENTRY}. Run npm run build:server first.`);
  process.exit(1);
}

console.log('persistence (built server, real clients, Bloxity verify stubbed)');

await runStore('json');

if (process.env.MONGOD_BINARY) {
  const dbPath = mkdtempSync(joinPath(tmpdir(), 'robot-persistence-mongod-'));
  const mongod = new Mongod(process.env.MONGOD_BINARY, dbPath);
  await mongod.start();
  try {
    await runStore('mongo', { mongoUri: `mongodb://127.0.0.1:${MONGOD_PORT}/robot_persistence_test`, mongod });
  } finally {
    await mongod.kill();
    rmSync(dbPath, { recursive: true, force: true });
  }
} else if (process.env.MONGODB_URI) {
  console.log('\n!!! MONGODB_URI is set: that database is about to be WIPED. !!!');
  await runStore('mongo', { mongoUri: process.env.MONGODB_URI });
} else {
  console.log('\n  -- SKIPPED MongoDB: set MONGOD_BINARY (or MONGODB_URI, which is WIPED) to run it');
}

section('server logs');
const unhandled = everyLine.filter((line) =>
  /Unhandled|uncaught|triggerUncaughtException|ERR_UNHANDLED_REJECTION/i.test(line),
);
check(unhandled.length === 0, `no unhandled errors in any server log${unhandled.length ? `:\n${unhandled.join('\n')}` : ''}`);
check(unexpectedExits.length === 0, `no server exited on its own${unexpectedExits.length ? `: ${unexpectedExits.join('; ')}` : ''}`);

console.log(failures === 0 ? '\nPERSISTENCE OK' : `\nPERSISTENCE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
