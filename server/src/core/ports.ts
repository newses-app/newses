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
  /** Keys are `/`-separated segments of letters, digits, `.`, `_`, `-`, not starting with `.`. */
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
}

/** Events are invalidation signals; clients refetch the data they describe. */
export type RealtimeEvent = { type: 'counters' };

export interface Realtime {
  publish(userId: number, event: RealtimeEvent): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(userId: number, listener: (event: RealtimeEvent) => void): () => void;
}
