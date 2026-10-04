import type { Db } from '../db/client.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import type { Fetcher } from '../core/feeds/http.ts';
import type { Jobs } from '../core/jobs.ts';
import type {
  Blob,
  BlobStore,
  EnqueueOptions,
  JobQueue,
  Logger,
  Realtime,
  RealtimeEvent,
} from '../core/ports.ts';

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Records published events and delivers them to local subscribers, as LISTEN/NOTIFY would. */
export class RecordingRealtime implements Realtime {
  readonly published: { userId: number; event: RealtimeEvent }[] = [];
  readonly #listeners = new Map<number, Set<(event: RealtimeEvent) => void>>();

  publish(userId: number, event: RealtimeEvent): Promise<void> {
    this.published.push({ userId, event });
    for (const listener of this.#listeners.get(userId) ?? []) listener(event);
    return Promise.resolve();
  }

  subscribe(userId: number, listener: (event: RealtimeEvent) => void): () => void {
    const listeners = this.#listeners.get(userId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(userId, listeners);
    return () => listeners.delete(listener);
  }
}

/** Records enqueued jobs; the dedupe key semantics match the real queue's "one queued per key". */
export class RecordingQueue implements JobQueue<Jobs> {
  readonly jobs: { name: keyof Jobs; data: object; key: string | undefined }[] = [];

  enqueue<N extends keyof Jobs>(
    name: N,
    data: Jobs[N],
    options: EnqueueOptions = {},
  ): Promise<boolean> {
    if (
      options.key !== undefined &&
      this.jobs.some((j) => j.name === name && j.key === options.key)
    ) {
      return Promise.resolve(false);
    }
    this.jobs.push({ name, data, key: options.key });
    return Promise.resolve(true);
  }

  work(): Promise<void> {
    return Promise.resolve();
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Blob>();

  put(key: string, blob: Blob): Promise<void> {
    this.blobs.set(key, blob);
    return Promise.resolve();
  }

  get(key: string): Promise<Blob | null> {
    return Promise.resolve(this.blobs.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}

export function testFeedDeps(
  db: Db,
  fetcher: Fetcher,
  overrides: Partial<FeedDeps> = {},
): FeedDeps {
  return {
    db,
    fetcher,
    queue: new RecordingQueue(),
    realtime: new RecordingRealtime(),
    blobs: new MemoryBlobStore(),
    settings: { updateIntervalSeconds: 1800, purgeDays: 60, disableAfterFailures: 3 },
    logger: silentLogger,
    hostGapMs: 0,
    ...overrides,
  };
}
