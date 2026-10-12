import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
  hostFetchStatsHourly,
  jobStatsHourly,
  requestStatsHourly,
  userActivityDaily,
  users,
} from '../../db/schema.ts';
import type { FetchPurpose } from '../feeds/http.ts';
import type { Logger } from '../ports.ts';

/** Which client made an API request: the apps send `X-RSS-Client`; compatibility APIs by path. */
export type ClientKind = 'web' | 'desktop' | 'mobile' | 'greader' | 'ttrss' | 'public' | 'other';

export type FetchOutcome =
  | 'ok'
  | 'not_modified'
  | 'client_error'
  | 'server_error'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'blocked'
  | 'other';

/** Requests at least this slow count as slow. */
export const SLOW_REQUEST_MS = 2000;

const HOUR_MS = 60 * 60 * 1000;
const hourOf = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface RequestBucket {
  hour: Date;
  client: ClientKind;
  statusClass: string;
  requests: number;
  slow: number;
  totalMs: number;
  maxMs: number;
}

interface ActivityBucket {
  userId: number;
  day: string;
  client: ClientKind;
  requests: number;
  lastSeenAt: Date;
}

interface FetchBucket {
  hour: Date;
  host: string;
  purpose: FetchPurpose;
  outcome: FetchOutcome;
  requests: number;
  bytes: number;
  totalMs: number;
}

interface JobBucket {
  hour: Date;
  job: string;
  runs: number;
  failures: number;
  totalMs: number;
  maxMs: number;
}

function bucket<T>(map: Map<string, T>, key: string, create: () => T): T {
  let value = map.get(key);
  if (!value) {
    value = create();
    map.set(key, value);
  }
  return value;
}

/**
 * Counts API requests, user activity, remote-host fetches, and job runs in memory, and adds them
 * to the hourly and daily rollup tables on `flush`. Statistics are best effort: a failed flush is
 * logged and its counts dropped.
 */
export class OpsRecorder {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #now: () => number;
  #requests = new Map<string, RequestBucket>();
  #activity = new Map<string, ActivityBucket>();
  #fetches = new Map<string, FetchBucket>();
  #jobs = new Map<string, JobBucket>();

  constructor(db: Db, logger: Logger, now: () => number = Date.now) {
    this.#db = db;
    this.#logger = logger;
    this.#now = now;
  }

  recordRequest(request: {
    client: ClientKind;
    status: number;
    durationMs: number;
    userId: number | null;
  }): void {
    const now = this.#now();
    const hour = hourOf(now);
    const statusClass = `${String(Math.floor(request.status / 100))}xx`;
    const ms = Math.round(request.durationMs);
    const stats = bucket(
      this.#requests,
      `${String(hour.getTime())}|${request.client}|${statusClass}`,
      () => ({
        hour,
        client: request.client,
        statusClass,
        requests: 0,
        slow: 0,
        totalMs: 0,
        maxMs: 0,
      }),
    );
    stats.requests++;
    if (ms >= SLOW_REQUEST_MS) stats.slow++;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);

    if (request.userId === null) return;
    const userId = request.userId;
    const day = dayOf(now);
    const activity = bucket(this.#activity, `${String(userId)}|${day}|${request.client}`, () => ({
      userId,
      day,
      client: request.client,
      requests: 0,
      lastSeenAt: new Date(now),
    }));
    activity.requests++;
    activity.lastSeenAt = new Date(now);
  }

  recordFetch(fetch: {
    host: string;
    purpose: FetchPurpose;
    outcome: FetchOutcome;
    bytes: number;
    durationMs: number;
  }): void {
    const hour = hourOf(this.#now());
    const stats = bucket(
      this.#fetches,
      `${String(hour.getTime())}|${fetch.host}|${fetch.purpose}|${fetch.outcome}`,
      () => ({
        hour,
        host: fetch.host,
        purpose: fetch.purpose,
        outcome: fetch.outcome,
        requests: 0,
        bytes: 0,
        totalMs: 0,
      }),
    );
    stats.requests++;
    stats.bytes += fetch.bytes;
    stats.totalMs += Math.round(fetch.durationMs);
  }

  recordJob(run: { job: string; ok: boolean; durationMs: number }): void {
    const hour = hourOf(this.#now());
    const ms = Math.round(run.durationMs);
    const stats = bucket(this.#jobs, `${String(hour.getTime())}|${run.job}`, () => ({
      hour,
      job: run.job,
      runs: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
    }));
    stats.runs++;
    if (!run.ok) stats.failures++;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
  }

  /** Adds the counts gathered since the last flush to the rollup tables. */
  async flush(): Promise<void> {
    const requests = [...this.#requests.values()];
    const activity = [...this.#activity.values()];
    const fetches = [...this.#fetches.values()];
    const jobs = [...this.#jobs.values()];
    this.#requests = new Map();
    this.#activity = new Map();
    this.#fetches = new Map();
    this.#jobs = new Map();
    await this.#write('requests', requests, (rows) =>
      this.#db
        .insert(requestStatsHourly)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            requestStatsHourly.hour,
            requestStatsHourly.client,
            requestStatsHourly.statusClass,
          ],
          set: {
            requests: sql`${requestStatsHourly.requests} + excluded.requests`,
            slow: sql`${requestStatsHourly.slow} + excluded.slow`,
            totalMs: sql`${requestStatsHourly.totalMs} + excluded.total_ms`,
            maxMs: sql`greatest(${requestStatsHourly.maxMs}, excluded.max_ms)`,
          },
        }),
    );
    await this.#write('activity', activity, async (rows) => {
      // Users deleted since their requests have no row to count against.
      const ids = [...new Set(rows.map((row) => row.userId))];
      const existing = await this.#db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, ids));
      const kept = new Set(existing.map((user) => user.id));
      const values = rows.filter((row) => kept.has(row.userId));
      if (values.length === 0) return;
      await this.#db
        .insert(userActivityDaily)
        .values(values)
        .onConflictDoUpdate({
          target: [userActivityDaily.userId, userActivityDaily.day, userActivityDaily.client],
          set: {
            requests: sql`${userActivityDaily.requests} + excluded.requests`,
            lastSeenAt: sql`greatest(${userActivityDaily.lastSeenAt}, excluded.last_seen_at)`,
          },
        });
    });
    await this.#write('fetches', fetches, (rows) =>
      this.#db
        .insert(hostFetchStatsHourly)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            hostFetchStatsHourly.hour,
            hostFetchStatsHourly.host,
            hostFetchStatsHourly.purpose,
            hostFetchStatsHourly.outcome,
          ],
          set: {
            requests: sql`${hostFetchStatsHourly.requests} + excluded.requests`,
            bytes: sql`${hostFetchStatsHourly.bytes} + excluded.bytes`,
            totalMs: sql`${hostFetchStatsHourly.totalMs} + excluded.total_ms`,
          },
        }),
    );
    await this.#write('jobs', jobs, (rows) =>
      this.#db
        .insert(jobStatsHourly)
        .values(rows)
        .onConflictDoUpdate({
          target: [jobStatsHourly.hour, jobStatsHourly.job],
          set: {
            runs: sql`${jobStatsHourly.runs} + excluded.runs`,
            failures: sql`${jobStatsHourly.failures} + excluded.failures`,
            totalMs: sql`${jobStatsHourly.totalMs} + excluded.total_ms`,
            maxMs: sql`greatest(${jobStatsHourly.maxMs}, excluded.max_ms)`,
          },
        }),
    );
  }

  async #write<T>(table: string, rows: T[], write: (rows: T[]) => Promise<unknown>): Promise<void> {
    if (rows.length === 0) return;
    try {
      await write(rows);
    } catch (err) {
      this.#logger.warn({ err, table, rows: rows.length }, 'Ops statistics flush failed');
    }
  }
}
