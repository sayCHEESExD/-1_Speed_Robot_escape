import { logger } from '../util/logger.js';

const SCOPE = 'persistence';

/** Backoff between retries of a failed write, in milliseconds. Last one repeats. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 30_000] as const;

interface Waiter {
  readonly version: number;
  readonly resolve: () => void;
}

interface Slot<T> {
  /** The newest snapshot waiting to be written, or null when nothing is. */
  value: T | null;
  /** Bumped on every `put`, so a waiter knows which write satisfies it. */
  version: number;
  /** The version most recently made durable. */
  landed: number;
  waiters: Waiter[];
}

/**
 * THE LATEST SNAPSHOT PER KEY, WRITTEN UNTIL IT LANDS.
 *
 * Three rules, and every one of them is about not losing a player's progress:
 *
 *  - PER KEY, never a batch of everything. Several pods share one database, so
 *    a write may only ever touch the one document it is about.
 *  - LATEST WINS. A snapshot still waiting is replaced by a newer one for the
 *    same key rather than queued behind it - a player who autosaves twice
 *    during an outage needs their last state written, not both in order.
 *  - NEVER DROPPED. A failed write is retried with backoff for as long as it
 *    takes. An outage costs latency, never data: the moment the database is
 *    back, every key that was waiting is written.
 *
 * `put` hands back a promise for callers that need to know the write LANDED -
 * a Bux grant is only settled once the profile that holds it is durable - and
 * an autosave simply ignores it.
 */
export class WriteQueue<T> {
  private readonly slots = new Map<string, Slot<T>>();
  private readonly write: (key: string, value: T) => Promise<void>;
  private readonly label: string;
  private running = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(label: string, write: (key: string, value: T) => Promise<void>) {
    this.label = label;
    this.write = write;
  }

  /** Keys with a snapshot still waiting to be written. */
  get pending(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.value !== null) count += 1;
    return count;
  }

  put(key: string, value: T): Promise<void> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { value: null, version: 0, landed: 0, waiters: [] };
      this.slots.set(key, slot);
    }
    slot.value = value;
    slot.version += 1;
    const version = slot.version;
    const done = new Promise<void>((resolve) => {
      slot.waiters.push({ version, resolve });
    });
    this.kick();
    return done;
  }

  /**
   * Resolve once nothing is waiting, or after `timeoutMs`.
   *
   * @returns true if everything landed, false if it gave up with writes still
   *          pending - which the shutdown path logs loudly rather than hides.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.pending === 0 && !this.running) return true;
    // A write waiting out a backoff is retried now rather than after it: the
    // process is about to go, and the database may well be back already.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.attempt = 0;
      this.kick();
    }
    let timeout: NodeJS.Timeout | null = null;
    const idle = new Promise<boolean>((resolve) => {
      this.idleWaiters.push(() => resolve(true));
    });
    const expired = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([idle, expired]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  private kick(): void {
    if (this.running || this.timer) return;
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const next = this.nextPending();
        if (!next) break;
        const [key, slot] = next;
        const value = slot.value as T;
        const version = slot.version;
        // Taken before the write, so a `put` that arrives mid-write leaves its
        // newer snapshot in the slot and is picked up by the next pass.
        slot.value = null;

        try {
          await this.write(key, value);
        } catch (error) {
          // Put it BACK unless something newer has already replaced it, then
          // stop and retry the whole queue after a backoff.
          if (slot.value === null) slot.value = value;
          const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
          this.attempt += 1;
          logger.warn(
            SCOPE,
            `${this.label} write for ${key} failed (${this.pending} waiting); ` +
              `retrying in ${delay}ms: ${describe(error)}`,
          );
          this.timer = setTimeout(() => {
            this.timer = null;
            this.kick();
          }, delay);
          this.timer.unref?.();
          return;
        }

        this.attempt = 0;
        slot.landed = Math.max(slot.landed, version);
        slot.waiters = slot.waiters.filter((waiter) => {
          if (waiter.version > slot.landed) return true;
          waiter.resolve();
          return false;
        });
      }
    } finally {
      this.running = false;
    }

    if (this.pending === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private nextPending(): [string, Slot<T>] | null {
    for (const entry of this.slots) if (entry[1].value !== null) return entry;
    return null;
  }
}

export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
