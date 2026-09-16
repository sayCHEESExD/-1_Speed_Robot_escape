import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../util/logger.js';
import type { PersistenceAdapter, StoredProfile } from './PersistenceAdapter.js';

const SCOPE = 'persistence';

/** Milliseconds a write waits for more changes before hitting the disk. */
const DEBOUNCE_MS = 1500;

/**
 * One JSON file, written debounced and ATOMICALLY.
 *
 * Atomic means: to a temp file, fsynced, then renamed over the real one. A
 * crash mid-write therefore leaves either the old file or the new one, never a
 * half-written save - which is the difference between a server restart and
 * every player losing their progression.
 *
 * The routine write is ASYNCHRONOUS, and that is not a micro-optimisation.
 * `fsync` is the slowest call in this file by orders of magnitude, and on a
 * managed host it is not writing to a local SSD - it is writing to a network
 * volume, where a flush costs tens to hundreds of milliseconds rather than a
 * fraction of one. Done synchronously it blocks Node's ONE thread, so the room
 * stops simulating, stops reading input and stops sending patches for the
 * whole flush. Every autosave and every banked stage became a visible hitch
 * for everyone in the room - a stall that simply does not reproduce on
 * localhost, because there the same call is essentially free.
 *
 * `flush()` stays synchronous. It runs on the shutdown path, where there is no
 * event loop left to await on and blocking is the only way to be sure the file
 * is on the disk before the process goes.
 */
export class JsonFilePersistence implements PersistenceAdapter {
  private readonly path: string;
  private readonly tempPath: string;
  private timer: NodeJS.Timeout | null = null;
  private pending: Map<string, StoredProfile> | null = null;
  /** True while an async write is in flight, so two never interleave. */
  private writing = false;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'profiles.json');
    this.tempPath = join(directory, 'profiles.json.tmp');
  }

  load(): Map<string, StoredProfile> {
    const profiles = new Map<string, StoredProfile>();
    try {
      if (!existsSync(this.path)) return profiles;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<
        string,
        Partial<StoredProfile>
      >;
      for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        profiles.set(id, {
          totalSpeed: numeric(value.totalSpeed),
          wins: numeric(value.wins),
          // A profile written before robots existed owns none, which
          // `bestOwnedRobot` resolves to the free starter rather than to
          // nothing at all.
          ownedRobots: numeric(value.ownedRobots),
          rebirths: numeric(value.rebirths),
          // A profile written before trails existed owns none, which is
          // exactly what a zero mask means - no migration needed.
          ownedTrails: numeric(value.ownedTrails),
          trailSlot: numeric(value.trailSlot),
          bestStage: numeric(value.bestStage),
          // Absent from every profile written before names existed, which is
          // exactly what the optional fields are for.
          displayName: typeof value.displayName === 'string' ? value.displayName : '',
          avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
          updatedAt: numeric(value.updatedAt),
        });
      }
      logger.info(SCOPE, `loaded ${profiles.size} profile(s) from ${this.path}`);
    } catch (error) {
      // A corrupt save must not stop the server booting: play continues with
      // empty profiles, and the next write replaces the bad file.
      logger.error(SCOPE, `failed to read ${this.path}:`, error);
    }
    return profiles;
  }

  save(profiles: Map<string, StoredProfile>): void {
    this.pending = profiles;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writeAsync();
    }, DEBOUNCE_MS);
    // Never hold the process open for a save that can be flushed on exit.
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  /**
   * The routine write, off the event loop.
   *
   * Overlapping writes are serialised rather than interleaved: a save that
   * arrives mid-flush leaves its snapshot in `pending` and is picked up by the
   * loop below, so the file is always written from ONE complete snapshot and
   * the last one always wins.
   */
  private async writeAsync(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending) {
        const profiles = this.pending;
        this.pending = null;
        const payload = JSON.stringify(Object.fromEntries(profiles), null, 0);

        try {
          await mkdir(this.directory, { recursive: true });
          const handle = await open(this.tempPath, 'w');
          try {
            await handle.writeFile(payload);
            // The durability guarantee, and the expensive part. Awaited, so
            // the thread keeps simulating while the disk does its work.
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(this.tempPath, this.path);
        } catch (error) {
          logger.error(SCOPE, `failed to write ${this.path}:`, error);
          // Fall back to the blocking path rather than lose the save. A rare
          // stall beats a lost session.
          this.pending = profiles;
          this.write();
          return;
        }
      }
    } finally {
      this.writing = false;
    }
  }

  /** The blocking write. Shutdown only, and the fallback if the async one fails. */
  private write(): void {
    const profiles = this.pending;
    if (!profiles) return;
    this.pending = null;

    try {
      mkdirSync(this.directory, { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(profiles), null, 0);

      // Temp file first, fsynced, then renamed. `rename` is atomic on every
      // platform we run on, so a reader only ever sees a complete file.
      const handle = openSync(this.tempPath, 'w');
      try {
        writeSync(handle, payload);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(this.tempPath, this.path);
    } catch (error) {
      logger.error(SCOPE, `failed to write ${this.path}:`, error);
      // Last resort: a plain non-atomic write is still better than losing
      // every player's progression to a rename that a filesystem refused.
      try {
        writeFileSync(this.path, JSON.stringify(Object.fromEntries(profiles)));
      } catch {
        /* already logged */
      }
    }
  }
}

const numeric = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
