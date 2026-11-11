import { randomUUID } from 'node:crypto';
import { sign } from '../core/crypto.ts';
import type { BlobStore, Logger, Realtime } from '../core/ports.ts';

/** Blob prefix of the markers; CloudFront serves it from the blob bucket. */
export const CHANGES_PREFIX = 'changes';

/**
 * Realtime where no process holds streams open (AWS): each event rewrites the user's change
 * marker, `changes/<HMAC of the user id>` in the blob store, which clients poll from the edge
 * instead of asking the API. Its text is new each time, so a poll sees the change. Writes for one
 * user while one is in flight become one more.
 */
export class MarkerRealtime implements Realtime {
  readonly #blobs: BlobStore;
  readonly #key: Buffer;
  readonly #logger: Logger;
  /** Per user with a write in flight: the events so far, and when the writes are done. */
  readonly #writing = new Map<number, { events: number; done: Promise<void> }>();

  constructor(blobs: BlobStore, key: Buffer, logger: Logger) {
    this.#blobs = blobs;
    this.#key = key;
    this.#logger = logger;
  }

  /** The marker's blob key; its path is the same with a leading slash. */
  markerKey(userId: number): string {
    return `${CHANGES_PREFIX}/${sign(this.#key, String(userId))}`;
  }

  changesPath(userId: number): string {
    return `/${this.markerKey(userId)}`;
  }

  /** Never throws: a marker not written only delays clients until the next one. */
  publish(userId: number): Promise<void> {
    const current = this.#writing.get(userId);
    if (current) {
      current.events++;
      return current.done;
    }
    const entry = { events: 1, done: Promise.resolve() };
    this.#writing.set(userId, entry);
    entry.done = (async () => {
      try {
        for (let written = 0; written < entry.events;) {
          written = entry.events;
          await this.#blobs.put(this.markerKey(userId), {
            data: new TextEncoder().encode(randomUUID()),
            contentType: 'text/plain',
          });
        }
      } catch (err) {
        this.#logger.warn({ err }, 'Could not write the change marker');
      } finally {
        this.#writing.delete(userId);
      }
    })();
    return entry.done;
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
