import type { Db } from '../db/client.ts';
import type { OpsSettings } from '../core/config.ts';
import { deriveKeys } from '../core/crypto.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import type { Fetcher } from '../core/feeds/http.ts';
import type { Jobs } from '../core/jobs.ts';
import type {
  ArchiveListQuery,
  ArchivePosition,
  ArchiveReader,
  ArchiveRow,
  ArchiveWriter,
  Blob,
  BlobStore,
  EnqueueOptions,
  JobQueue,
  Logger,
  Realtime,
  RealtimeEvent,
} from '../core/ports.ts';

/** APP_SECRET for tests. */
export const TEST_APP_SECRET = 'test app secret of at least thirty-two characters';

/** Ops settings with the defaults, and no alert email. */
export const TEST_OPS_SETTINGS: OpsSettings = {
  retentionDays: 90,
  auditRetentionDays: 365,
  hostHourlyBudget: 200,
  alertEmail: null,
};

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
  readonly jobs: {
    name: keyof Jobs;
    data: object;
    key: string | undefined;
    delaySeconds?: number | undefined;
  }[] = [];

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
    this.jobs.push({ name, data, key: options.key, delaySeconds: options.delaySeconds });
    return Promise.resolve(true);
  }

  work(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The archive in memory, read as the real readers do: each article (feed URL and GUID) as written
 * last, in the archive's order. `rows` keeps every row written; `fail` makes writes throw, as an
 * unreachable store would.
 */
export class MemoryArchive implements ArchiveWriter, ArchiveReader {
  readonly rows: ArchiveRow[] = [];
  fail = false;

  write(rows: ArchiveRow[]): Promise<void> {
    if (this.fail) return Promise.reject(new Error('archive unavailable'));
    this.rows.push(...rows);
    return Promise.resolve();
  }

  list(query: ArchiveListQuery): Promise<ArchiveRow[]> {
    const { after } = query;
    const rows = this.#latest()
      .filter((r) => query.feedUrls.includes(r.feedUrl))
      .filter((r) => {
        const text = `${r.title ?? ''} ${r.text ?? ''}`.toLowerCase();
        return query.terms.every((term) => text.includes(term));
      })
      .filter((r) => !after || archiveOrder(r, after) > 0)
      .sort(archiveOrder)
      .slice(0, query.limit)
      .map((r) => ({ ...r, content: null, enclosures: [], text: r.text?.slice(0, 300) ?? null }));
    return Promise.resolve(rows);
  }

  get(month: string, feedUrl: string, guid: string): Promise<ArchiveRow | null> {
    const row = this.#latest().find(
      (r) => r.feedUrl === feedUrl && r.guid === guid && r.sortAt.toISOString().startsWith(month),
    );
    return Promise.resolve(row ?? null);
  }

  compact(): Promise<number> {
    return Promise.resolve(0);
  }

  #latest(): ArchiveRow[] {
    const latest = new Map<string, ArchiveRow>();
    for (const row of this.rows) {
      const key = `${row.feedUrl}\n${row.guid}`;
      const seen = latest.get(key);
      if (!seen || row.archivedAt >= seen.archivedAt) latest.set(key, row);
    }
    return [...latest.values()];
  }
}

/** The archive's order: newest `sortAt` first, then feed URL and GUID, descending. */
function archiveOrder(a: ArchivePosition, b: ArchivePosition): number {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    b.sortAt.getTime() - a.sortAt.getTime() || order(b.feedUrl, a.feedUrl) || order(b.guid, a.guid)
  );
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

  async *list(prefix = ''): AsyncIterable<string> {
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) yield await Promise.resolve(key);
    }
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
    archive: null,
    settings: { updateIntervalSeconds: 1800, purgeDays: 60, disableAfterFailures: 3 },
    logger: silentLogger,
    keys: deriveKeys(TEST_APP_SECRET),
    hostGapMs: 0,
    ...overrides,
  };
}
