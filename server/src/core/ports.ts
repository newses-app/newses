// Interfaces core depends on. Implementations live in src/adapters and are wired by src/entrypoints.

export interface LogFn {
  (msg: string): void;
  (obj: object, msg?: string): void;
}

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** Maps job names to their payloads. */
export type JobMap = Record<string, object>;

export interface JobDefinition {
  /** At most one queued job per `key`; enqueueing a duplicate is a no-op. */
  dedupeByKey?: boolean;
  retryLimit?: number;
  /** Exponential backoff starting from this many seconds. */
  retryDelaySeconds?: number;
  /** Seconds a job may run before it is retried. */
  timeoutSeconds?: number;
}

export type JobDefinitions<J extends JobMap> = { [N in keyof J]: JobDefinition };

export interface EnqueueOptions {
  key?: string;
  delaySeconds?: number;
}

export interface JobQueue<J extends JobMap> {
  /** Returns false when the job was dropped as a duplicate. */
  enqueue<N extends keyof J & string>(
    name: N,
    data: J[N],
    options?: EnqueueOptions,
  ): Promise<boolean>;
  /** Throwing from the handler fails the attempt and schedules a retry. */
  work<N extends keyof J & string>(
    name: N,
    handler: (data: J[N]) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
}

export interface Scheduler {
  /** Runs `task` on start, then `intervalSeconds` after each run finishes. Runs never overlap. */
  every(name: string, intervalSeconds: number, task: () => Promise<void>): void;
  start(): void;
  /** Stops scheduling and waits for running tasks to finish. */
  stop(): Promise<void>;
}

export interface Blob {
  data: Uint8Array;
  contentType: string;
}

export interface BlobStore {
  /**
   * Keys are `/`-separated segments of letters, digits, `.`, `_`, `-`, `=`, not starting with `.`
   * or `=`.
   */
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
}

export interface ArchivedEnclosure {
  url: string;
  mimeType: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** An article kept in cold storage once purge (or the TTRSS importer) would otherwise lose it. */
export interface ArchiveRow {
  /** The `entries` id it had; null for articles imported straight into the archive. */
  id: number | null;
  feedUrl: string;
  feedTitle: string | null;
  guid: string;
  link: string | null;
  title: string | null;
  author: string | null;
  /** Sanitised HTML. */
  content: string | null;
  /** Plain text of `content`, for search. */
  text: string | null;
  lang: string | null;
  publishedAt: Date | null;
  sourceUpdatedAt: Date | null;
  fetchedAt: Date;
  sortAt: Date;
  archivedAt: Date;
  enclosures: ArchivedEnclosure[];
}

export interface ArchiveWriter {
  /** The rows are durable once this resolves. */
  write(rows: ArchiveRow[]): Promise<void>;
}

/** An archive row's place in the archive's order: newest `sortAt` first, then feed URL and GUID. */
export interface ArchivePosition {
  sortAt: Date;
  feedUrl: string;
  guid: string;
}

export interface ArchiveListQuery {
  feedUrls: string[];
  /** Lower-case words that must all appear in the title or text. */
  terms: string[];
  /** Only rows after this one in the archive's order. */
  after: ArchivePosition | null;
  limit: number;
}

/** Reads the archive. Each article (feed URL and GUID) appears once, as archived last. */
export interface ArchiveReader {
  /** Headlines in the archive's order: no content or enclosures, and `text` cut short. */
  list(query: ArchiveListQuery): Promise<ArchiveRow[]>;
  /** One article, looked up in the month folder of its `sortAt` (`YYYY-MM`). */
  get(month: string, feedUrl: string, guid: string): Promise<ArchiveRow | null>;
  /**
   * Merges each finished month with several files into one, until `deadline` (epoch ms);
   * returns how many months were merged.
   */
  compact(deadline: number): Promise<number>;
}

/** Events are invalidation signals; clients refetch the data they describe. */
export type RealtimeEvent = { type: 'counters' };

export interface Realtime {
  publish(userId: number, event: RealtimeEvent): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(userId: number, listener: (event: RealtimeEvent) => void): () => void;
}
