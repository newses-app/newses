import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { feedSources, fetchHosts, subscriptions } from '../../db/schema.ts';
import type { FeedSettings } from '../config.ts';
import { DomainError, ThrottledError } from '../errors.ts';
import type { Jobs } from '../jobs.ts';
import type { JobQueue, Logger } from '../ports.ts';
import { userPrefInt } from '../prefs.ts';
import { decodeBody } from './decode.ts';
import type { FullTextService } from './fulltext.ts';
import type { HostLimiter } from './host-limiter.ts';
import { type Fetcher, FetchError, type FetchResult } from './http.ts';
import type { Ingester } from './ingest.ts';
import { FeedParseError, type ParsedFeed, parseFeed } from './parse.ts';
import { normalizeFeedUrl } from './url.ts';

const MIN_INTERVAL_SECONDS = 5 * 60;
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;
/** Publisher hints (Cache-Control, RSS ttl) lengthen the interval up to this. */
const MAX_HINT_SECONDS = 24 * 60 * 60;
/** Intervals are stretched by up to this fraction so feeds added together drift apart. */
const JITTER = 0.1;
/** A host that answers 429 without Retry-After is left alone this long. */
const DEFAULT_HOST_COOLDOWN_SECONDS = 10 * 60;
/** "Update now" is a no-op when the feed was fetched this recently. */
const REFRESH_MIN_AGE_SECONDS = 60;
/** Dispatch marks claimed sources as not due for this long; a finished fetch sets the real time. */
const CLAIM_SECONDS = 15 * 60;
const DISPATCH_BATCH = 500;
/** Sources of one host per fetch job, so a job fits the queue's 15-minute timeout. */
const HOST_BATCH = 20;
const FAVICON_REFRESH_DAYS = 30;

export type FeedSourceRow = typeof feedSources.$inferSelect;

/** Delay after `failures` consecutive failures: interval × 2^(failures−1), capped at a day. */
export function backoffSeconds(
  intervalSeconds: number,
  failures: number,
  retryAfterSeconds: number | null,
): number {
  const backoff = Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** Math.max(0, failures - 1));
  return Math.max(backoff, retryAfterSeconds ?? 0);
}

/** Interval stretched by the publisher's hints (capped) and up to 10 % random jitter. */
export function nextFetchSeconds(
  intervalSeconds: number,
  hints: (number | null)[],
  random = Math.random(),
): number {
  const hint = Math.min(MAX_HINT_SECONDS, Math.max(0, ...hints.map((h) => h ?? 0)));
  const base = Math.max(intervalSeconds, hint);
  return Math.round(base * (1 + JITTER * random));
}

const isHostThrottle = (err: FetchError) =>
  err.status === 429 || (err.status === 503 && err.retryAfterSeconds !== null);

export class FeedUpdater {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #ingester: Ingester;
  readonly #queue: JobQueue<Jobs>;
  readonly #settings: FeedSettings;
  readonly #logger: Logger;
  readonly #hosts: HostLimiter;
  readonly #fullText: FullTextService | undefined;

  constructor(deps: {
    /** Queues full text for opted-in feeds' new entries. */
    fullText?: FullTextService;
    db: Db;
    fetcher: Fetcher;
    ingester: Ingester;
    queue: JobQueue<Jobs>;
    settings: FeedSettings;
    logger: Logger;
    hosts: HostLimiter;
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#ingester = deps.ingester;
    this.#queue = deps.queue;
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#hosts = deps.hosts;
    this.#fullText = deps.fullText;
  }

  /**
   * Claims due, enabled, subscribed sources, at most HOST_BATCH per host, and enqueues one fetch
   * job per host, so a host's feeds are fetched one after another whichever process runs them.
   * Returns the number of sources claimed.
   */
  async dispatchDue(): Promise<number> {
    const claimed = await this.#db.execute<{ id: number; url: string }>(sql`
      WITH due AS (
        SELECT fs.id, fs.url, fs.next_fetch_at FROM feed_sources fs
        WHERE fs.next_fetch_at <= now() AND fs.disabled_at IS NULL
          AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_source_id = fs.id)
        ORDER BY fs.next_fetch_at
        LIMIT ${DISPATCH_BATCH}
        FOR UPDATE SKIP LOCKED
      ), ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY substring(url FROM '^[^:]+://([^/?#]+)') ORDER BY next_fetch_at) AS n
        FROM due
      )
      UPDATE feed_sources fs SET next_fetch_at = now() + make_interval(secs => ${CLAIM_SECONDS})
      FROM ranked WHERE fs.id = ranked.id AND ranked.n <= ${HOST_BATCH}
      RETURNING fs.id, fs.url`);
    const byHost = new Map<string, number[]>();
    for (const { id, url } of claimed.rows) {
      const host = new URL(url).host;
      byHost.set(host, [...(byHost.get(host) ?? []), id]);
    }
    for (const [host, ids] of byHost) await this.#enqueueFetch(host, ids);
    return claimed.rows.length;
  }

  /** One fetch job per host may wait in the queue; sources that could not join it stay due. */
  async #enqueueFetch(host: string, feedSourceIds: number[]): Promise<void> {
    if (await this.#queue.enqueue('feed.fetch', { feedSourceIds }, { key: host })) return;
    await this.#db
      .update(feedSources)
      .set({ nextFetchAt: sql`now()` })
      .where(inArray(feedSources.id, feedSourceIds));
  }

  /**
   * "Update now": re-enables a disabled feed and fetches it as soon as a worker is free, unless it
   * was fetched within the last minute. Throws `throttled` while the host's Retry-After runs.
   */
  async refresh(userId: number, subscriptionId: number): Promise<void> {
    const [row] = await this.#db
      .select({ source: feedSources })
      .from(subscriptions)
      .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
    if (!row) throw new DomainError('not_found', 'Subscription not found');
    const { source } = row;
    const now = Date.now();
    if (source.blockedUntil && source.blockedUntil.getTime() > now) {
      throw new ThrottledError(
        Math.ceil((source.blockedUntil.getTime() - now) / 1000),
        'The feed host asked not to be fetched again yet',
      );
    }
    const recent =
      source.disabledAt === null &&
      source.lastFetchedAt !== null &&
      now - source.lastFetchedAt.getTime() < REFRESH_MIN_AGE_SECONDS * 1000;
    if (recent) return;
    await this.#db
      .update(feedSources)
      .set({
        disabledAt: null,
        errorCount: 0,
        nextFetchAt: sql`now() + make_interval(secs => ${CLAIM_SECONDS})`,
      })
      .where(eq(feedSources.id, source.id));
    await this.#enqueueFetch(new URL(source.url).host, [source.id]);
  }

  /** Updates sources one after another. */
  async updateMany(feedSourceIds: number[]): Promise<void> {
    for (const id of feedSourceIds) await this.update(id);
  }

  /** Fetches one source, ingests its entries, and schedules the next fetch. */
  async update(feedSourceId: number): Promise<void> {
    const [source] = await this.#db
      .select()
      .from(feedSources)
      .where(and(eq(feedSources.id, feedSourceId), isNull(feedSources.disabledAt)));
    if (!source) return;
    const interval = await this.intervalSeconds(source.id);
    const host = new URL(source.url).host;
    await this.#hosts.run(host, async () => {
      const cooldown = await this.#hostCooldownSeconds(host);
      if (cooldown > 0) {
        await this.#postpone(source.id, cooldown);
        return;
      }
      try {
        const response = await this.#fetcher.fetch(source.url, {
          etag: source.etag,
          lastModified: source.lastModified,
        });
        const feed = response.notModified
          ? null
          : parseFeed(decodeBody(response.body, response.contentType), source.url);
        await this.applyFetch(source, interval, response, feed);
      } catch (err) {
        await this.#recordFailure(source, host, interval, err);
      }
    });
  }

  /**
   * Records a successful fetch of `source`: ingests the parsed feed (null when not modified),
   * stores validators and hints, adopts permanent redirects, and schedules the next fetch.
   * Subscribing uses this for the fetch it already made, so a new feed is not fetched twice.
   */
  async applyFetch(
    source: FeedSourceRow,
    interval: number,
    response: FetchResult,
    feed: ParsedFeed | null,
  ): Promise<void> {
    let { title, siteUrl, ttlSeconds } = source;
    if (feed) {
      title = feed.title ?? title;
      siteUrl = feed.siteUrl ?? siteUrl;
      ttlSeconds = feed.ttlSeconds;
      const result = await this.#ingester.ingest(source.id, siteUrl, feed.entries);
      this.#logger.debug({ feedSourceId: source.id, ...result }, 'Feed ingested');
      if (result.inserted > 0) await this.#fullText?.queueFor(source.id);
    }
    const next = nextFetchSeconds(interval, [ttlSeconds, response.maxAgeSeconds]);
    await this.#db
      .update(feedSources)
      .set({
        title,
        siteUrl,
        ttlSeconds,
        etag: response.etag ?? (response.notModified ? source.etag : null),
        lastModified: response.lastModified ?? (response.notModified ? source.lastModified : null),
        fetchIntervalSeconds: next,
        lastFetchedAt: sql`now()`,
        nextFetchAt: sql`now() + make_interval(secs => ${next})`,
        errorCount: 0,
        lastError: null,
        lastErrorAt: null,
        blockedUntil: null,
      })
      .where(eq(feedSources.id, source.id));
    if (response.permanentUrl) await this.#adoptPermanentUrl(source, response.permanentUrl);

    const iconStale =
      !source.faviconCheckedAt ||
      Date.now() - source.faviconCheckedAt.getTime() > FAVICON_REFRESH_DAYS * 24 * 60 * 60 * 1000;
    if (iconStale && siteUrl) {
      await this.#queue.enqueue(
        'feed.favicon',
        { feedSourceId: source.id },
        { key: String(source.id) },
      );
    }
  }

  /**
   * The source's base interval: the shortest among its subscribers, each taking the subscription's
   * override, else the user's preference, else the server default; never below five minutes.
   */
  async intervalSeconds(feedSourceId: number): Promise<number> {
    const [row] = await this.#db
      .select({
        seconds: sql<number | null>`min(coalesce(
          ${subscriptions.updateIntervalSeconds},
          ${userPrefInt(sql`${subscriptions.userId}`, 'updateIntervalMinutes')} * 60,
          ${this.#settings.updateIntervalSeconds}))`,
      })
      .from(subscriptions)
      .where(eq(subscriptions.feedSourceId, feedSourceId));
    return Math.max(MIN_INTERVAL_SECONDS, row?.seconds ?? this.#settings.updateIntervalSeconds);
  }

  /** Moves the source to the URL its feed permanently redirected to, unless another source has it. */
  async #adoptPermanentUrl(source: FeedSourceRow, permanentUrl: string): Promise<void> {
    let url: string;
    try {
      url = normalizeFeedUrl(permanentUrl);
    } catch {
      return;
    }
    if (url === source.url) return;
    const moved = await this.#db.execute(sql`
      UPDATE feed_sources SET url = ${url}
      WHERE id = ${source.id} AND NOT EXISTS (SELECT 1 FROM feed_sources WHERE url = ${url})`);
    if (moved.rowCount)
      this.#logger.info({ feedSourceId: source.id, from: source.url, to: url }, 'Feed moved');
  }

  /** Seconds until `host` may be fetched again; 0 when it has not asked to wait. */
  async #hostCooldownSeconds(host: string): Promise<number> {
    const [row] = await this.#db
      .select({
        seconds: sql<number>`ceil(extract(epoch FROM ${fetchHosts.blockedUntil} - now()))::int`,
      })
      .from(fetchHosts)
      .where(and(eq(fetchHosts.host, host), sql`${fetchHosts.blockedUntil} > now()`));
    return row?.seconds ?? 0;
  }

  /** Reschedules without counting a failure. */
  async #postpone(feedSourceId: number, seconds: number): Promise<void> {
    const delay = nextFetchSeconds(seconds, []);
    await this.#db
      .update(feedSources)
      .set({ nextFetchAt: sql`now() + make_interval(secs => ${delay})` })
      .where(eq(feedSources.id, feedSourceId));
  }

  async #recordFailure(
    source: FeedSourceRow,
    host: string,
    interval: number,
    err: unknown,
  ): Promise<void> {
    if (!(err instanceof FetchError || err instanceof FeedParseError)) throw err;
    const failures = source.errorCount + 1;
    const gone = err instanceof FetchError && err.status === 410;
    const disable = gone || failures >= this.#settings.disableAfterFailures;
    let retryAfter = err instanceof FetchError ? err.retryAfterSeconds : null;
    if (err instanceof FetchError && isHostThrottle(err)) {
      retryAfter ??= DEFAULT_HOST_COOLDOWN_SECONDS;
      const until = sql`now() + make_interval(secs => ${retryAfter})`;
      await this.#db
        .insert(fetchHosts)
        .values({ host, blockedUntil: until })
        .onConflictDoUpdate({
          target: fetchHosts.host,
          set: { blockedUntil: sql`greatest(${fetchHosts.blockedUntil}, excluded.blocked_until)` },
        });
    }
    const message =
      err instanceof FeedParseError ? `Not a valid feed: ${err.message}` : err.message;
    const delay = nextFetchSeconds(backoffSeconds(interval, failures, retryAfter), []);
    await this.#db
      .update(feedSources)
      .set({
        errorCount: failures,
        lastError: message.slice(0, 1000),
        lastErrorAt: sql`now()`,
        lastFetchedAt: sql`now()`,
        fetchIntervalSeconds: interval,
        nextFetchAt: sql`now() + make_interval(secs => ${delay})`,
        blockedUntil:
          retryAfter === null ? null : sql`now() + make_interval(secs => ${retryAfter})`,
        ...(disable && { disabledAt: sql`now()` }),
      })
      .where(eq(feedSources.id, source.id));
    this.#logger.info(
      { feedSourceId: source.id, failures, disabled: disable, err: message },
      'Feed fetch failed',
    );
  }
}
