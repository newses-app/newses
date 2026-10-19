import { randomUUID } from 'node:crypto';
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
import { type Fetcher, FetchError, type FetchResult } from './http.ts';
import type { Ingester } from './ingest.ts';
import { DEFAULT_HOST_COOLDOWN_SECONDS, isHostThrottle } from './polite-fetcher.ts';
import { FeedParseError, type ParsedFeed, parseFeed } from './parse.ts';
import {
  afterSuccess,
  afterThrottle,
  effectiveInterval,
  jittered,
  MAX_HINT_SECONDS,
  type Schedule,
  type ScheduleInputs,
  sourceHost,
} from './schedule.ts';
import { hostOf, normalizeFeedUrl } from './url.ts';

const MIN_INTERVAL_SECONDS = 5 * 60;
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;
/** "Update now" is a no-op when the feed was fetched this recently. */
const REFRESH_MIN_AGE_SECONDS = 60;
/** Dispatch marks claimed sources as not due for this long; a finished fetch sets the real time. */
const CLAIM_SECONDS = 15 * 60;
const DISPATCH_BATCH = 500;
/** Sources of one host per fetch job, so a job fits the queue's 15-minute timeout. */
const HOST_BATCH = 20;
const FAVICON_REFRESH_DAYS = 30;
/** A fetch job's hold on its host, renewed before each source, so a crashed job frees it soon. */
const LEASE_SECONDS = 2 * 60;
/** A job whose host is held by another waits this long before it is run again. */
const LEASE_WAIT_SECONDS = 60;

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

/** The longest of the publisher's hints, capped at a day; null when it gave none. */
export function hintSeconds(hints: (number | null)[]): number | null {
  const given = hints.filter((h): h is number => h !== null && h > 0);
  return given.length === 0 ? null : Math.min(MAX_HINT_SECONDS, Math.max(...given));
}

export class FeedUpdater {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #ingester: Ingester;
  readonly #queue: JobQueue<Jobs>;
  readonly #settings: FeedSettings;
  readonly #logger: Logger;
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
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#ingester = deps.ingester;
    this.#queue = deps.queue;
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#fullText = deps.fullText;
  }

  /**
   * Claims due, enabled sources with an unpaused subscription, at most HOST_BATCH per host, and
   * enqueues one fetch job per host, so a host's feeds are fetched one after another whichever
   * process runs them.
   * Returns the number of sources claimed.
   */
  async dispatchDue(): Promise<number> {
    const claimed = await this.#db.execute<{ id: number; url: string }>(sql`
      WITH due AS (
        SELECT fs.id, fs.url, fs.next_fetch_at FROM feed_sources fs
        WHERE fs.next_fetch_at <= now() AND fs.disabled_at IS NULL
          AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_source_id = fs.id AND NOT s.paused)
        ORDER BY fs.next_fetch_at
        LIMIT ${DISPATCH_BATCH}
        FOR UPDATE SKIP LOCKED
      ), ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY ${sourceHost(sql`url`)} ORDER BY next_fetch_at) AS n
        FROM due
      )
      UPDATE feed_sources fs SET next_fetch_at = now() + make_interval(secs => ${CLAIM_SECONDS})
      FROM ranked WHERE fs.id = ranked.id AND ranked.n <= ${HOST_BATCH}
      RETURNING fs.id, fs.url`);
    const byHost = new Map<string, number[]>();
    for (const { id, url } of claimed.rows) {
      const host = hostOf(url);
      byHost.set(host, [...(byHost.get(host) ?? []), id]);
    }
    for (const [host, ids] of byHost) await this.#enqueueFetch(host, ids);
    return claimed.rows.length;
  }

  /** One fetch job per host may wait in the queue; sources that could not join it stay due. */
  async #enqueueFetch(host: string, feedSourceIds: number[]): Promise<void> {
    if (await this.#queue.enqueue('feed.fetch', { feedSourceIds }, { key: host })) return;
    await this.#release(feedSourceIds);
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
    await this.#enqueueFetch(hostOf(source.url), [source.id]);
  }

  /**
   * Job: updates one host's sources one after another, holding the host's lease, so no two
   * processes work through a host's feeds at once. While another job holds it, the sources stay
   * claimed and the job is queued again in a minute.
   */
  async updateMany(feedSourceIds: number[]): Promise<void> {
    const [first] = await this.#db
      .select({ url: feedSources.url })
      .from(feedSources)
      .where(inArray(feedSources.id, feedSourceIds))
      .limit(1);
    if (!first) return;
    const host = hostOf(first.url);
    const lease = randomUUID();
    if (!(await this.#lease(host, lease))) {
      await this.#awaitLease(host, feedSourceIds);
      return;
    }
    try {
      for (const [index, id] of feedSourceIds.entries()) {
        // A lease lost to an overrun is not taken back: the rest wait for the next dispatch.
        if (index > 0 && !(await this.#lease(host, lease))) {
          await this.#release(feedSourceIds.slice(index));
          return;
        }
        await this.update(id);
      }
    } finally {
      await this.#db
        .update(fetchHosts)
        .set({ leaseId: null, leasedUntil: null })
        .where(and(eq(fetchHosts.host, host), eq(fetchHosts.leaseId, lease)));
    }
  }

  /** Takes or renews the host's lease for LEASE_SECONDS; false while another job holds it. */
  async #lease(host: string, lease: string): Promise<boolean> {
    const until = sql`now() + make_interval(secs => ${LEASE_SECONDS})`;
    const taken = await this.#db
      .insert(fetchHosts)
      .values({ host, leaseId: lease, leasedUntil: until })
      .onConflictDoUpdate({
        target: fetchHosts.host,
        set: { leaseId: lease, leasedUntil: until },
        setWhere: sql`${fetchHosts.leaseId} = ${lease}
          OR coalesce(${fetchHosts.leasedUntil}, '-infinity') < now()`,
      })
      .returning({ host: fetchHosts.host });
    return taken.length > 0;
  }

  /** Keeps the sources claimed and queues their job again, or leaves them due when one waits. */
  async #awaitLease(host: string, feedSourceIds: number[]): Promise<void> {
    await this.#db
      .update(feedSources)
      .set({
        nextFetchAt: sql`greatest(${feedSources.nextFetchAt}, now() + make_interval(secs => ${CLAIM_SECONDS}))`,
      })
      .where(inArray(feedSources.id, feedSourceIds));
    const queued = await this.#queue.enqueue(
      'feed.fetch',
      { feedSourceIds },
      { key: host, delaySeconds: LEASE_WAIT_SECONDS },
    );
    if (!queued) await this.#release(feedSourceIds);
  }

  /** Makes claimed sources due again, for the next dispatch. */
  async #release(feedSourceIds: number[]): Promise<void> {
    await this.#db
      .update(feedSources)
      .set({ nextFetchAt: sql`now()` })
      .where(inArray(feedSources.id, feedSourceIds));
  }

  /** Fetches one source, ingests its entries, and schedules the next fetch. */
  async update(feedSourceId: number): Promise<void> {
    const [source] = await this.#db
      .select()
      .from(feedSources)
      .where(and(eq(feedSources.id, feedSourceId), isNull(feedSources.disabledAt)));
    if (!source) return;
    let response: FetchResult;
    let feed: ParsedFeed | null;
    try {
      response = await this.#fetcher.fetch(source.url, {
        purpose: 'feed',
        etag: source.etag,
        lastModified: source.lastModified,
      });
      feed = response.notModified
        ? null
        : parseFeed(decodeBody(response.body, response.contentType), source.url);
    } catch (err) {
      // A paused host is not the feed's failure: it is fetched once the pause ends.
      if (err instanceof FetchError && err.code === 'host_blocked')
        await this.#postpone(source.id, err.retryAfterSeconds ?? DEFAULT_HOST_COOLDOWN_SECONDS);
      else await this.#recordFailure(source, err);
      return;
    }
    await this.applyFetch(source, response, feed);
  }

  /**
   * Records a successful fetch of `source`: ingests the parsed feed (null when not modified),
   * stores validators and hints, eases a slowdown, adopts permanent redirects, and schedules the
   * next fetch. Subscribing uses this for the fetch it already made, so a new feed is not fetched
   * twice.
   */
  async applyFetch(
    source: FeedSourceRow,
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
    const hint = hintSeconds([ttlSeconds, response.maxAgeSeconds]);
    const inputs = { ...(await this.#inputsOf(source.id)), hint };
    const eased = afterSuccess(
      source.slowdownSeconds,
      source.slowdownOkCount,
      this.#interval({ ...inputs, slowdown: null }).seconds,
    );
    const schedule = this.#interval({ ...inputs, slowdown: eased.slowdown });
    const next = jittered(schedule.seconds);
    await this.#db
      .update(feedSources)
      .set({
        title,
        siteUrl,
        ttlSeconds,
        etag: response.etag ?? (response.notModified ? source.etag : null),
        lastModified: response.lastModified ?? (response.notModified ? source.lastModified : null),
        hintSeconds: hint,
        slowdownSeconds: eased.slowdown,
        slowdownOkCount: eased.okCount,
        fetchIntervalSeconds: schedule.seconds,
        fetchIntervalReason: schedule.reason,
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

  /** The source's interval in effect, from its subscriptions, stored hint and slowdown, and host. */
  async schedule(feedSourceId: number): Promise<Schedule> {
    return this.#interval(await this.#inputsOf(feedSourceId));
  }

  /** The user's default interval: their preference, else the server's. */
  async userIntervalSeconds(userId: number): Promise<number> {
    const { rows } = await this.#db.execute<{ seconds: number | null }>(
      sql`SELECT ${userPrefInt(sql`${userId}::int`, 'updateIntervalMinutes')} * 60 AS seconds`,
    );
    return Math.max(MIN_INTERVAL_SECONDS, rows[0]?.seconds ?? this.#settings.updateIntervalSeconds);
  }

  /**
   * Recomputes the sources' intervals after a change of settings. A source fetched normally moves
   * to its last fetch plus the new interval (not before now); failing, new, and imminent or
   * claimed sources keep their time.
   */
  async reschedule(feedSourceIds: number[]): Promise<void> {
    const inputs = await this.#inputs(feedSourceIds);
    if (inputs.size === 0) return;
    const values = [...inputs].map(([id, i]) => {
      const { seconds, reason } = this.#interval(i);
      return sql`(${id}::int, ${seconds}::int, ${reason}::text, ${jittered(seconds)}::int)`;
    });
    await this.#db.execute(sql`
      UPDATE feed_sources fs SET
        fetch_interval_seconds = v.seconds,
        fetch_interval_reason = v.reason,
        next_fetch_at = CASE
          WHEN fs.disabled_at IS NOT NULL OR fs.error_count > 0 OR fs.last_fetched_at IS NULL
            OR fs.next_fetch_at <= now() + make_interval(secs => ${CLAIM_SECONDS})
          THEN fs.next_fetch_at
          ELSE greatest(fs.last_fetched_at + make_interval(secs => v.delay), now(),
            coalesce(fs.blocked_until, now()))
        END
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, seconds, reason, delay)
      WHERE fs.id = v.id`);
  }

  /** Reschedules the sources the user subscribes to, after their default interval changed. */
  async rescheduleUser(userId: number): Promise<void> {
    const rows = await this.#db
      .selectDistinct({ id: subscriptions.feedSourceId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    await this.reschedule(rows.map((r) => r.id));
  }

  /** Reschedules the sources of a host, after its minimum interval changed. */
  async rescheduleHost(host: string): Promise<void> {
    const rows = await this.#db
      .select({ id: feedSources.id })
      .from(feedSources)
      .where(sql`${sourceHost(sql`${feedSources.url}`)} = ${host}`);
    await this.reschedule(rows.map((r) => r.id));
  }

  #interval(inputs: ScheduleInputs): Schedule {
    return effectiveInterval(inputs, this.#settings.updateIntervalSeconds);
  }

  async #inputsOf(feedSourceId: number): Promise<ScheduleInputs> {
    return (
      (await this.#inputs([feedSourceId])).get(feedSourceId) ?? {
        base: null,
        hint: null,
        slowdown: null,
        siteMinimum: null,
      }
    );
  }

  /**
   * Each source's schedule inputs. The base is the shortest among its unpaused subscriptions, each
   * taking the subscription's override, else the user's preference, else the server default;
   * never below five minutes.
   */
  async #inputs(feedSourceIds: number[]): Promise<Map<number, ScheduleInputs>> {
    if (feedSourceIds.length === 0) return new Map();
    const { rows } = await this.#db.execute<{
      id: number;
      base: number | null;
      hint: number | null;
      slowdown: number | null;
      site_minimum: number | null;
    }>(sql`
      SELECT fs.id,
        (SELECT min(coalesce(s.update_interval_seconds,
            ${userPrefInt(sql`s.user_id`, 'updateIntervalMinutes')} * 60,
            ${this.#settings.updateIntervalSeconds}::int))
          FROM subscriptions s WHERE s.feed_source_id = fs.id AND NOT s.paused) AS base,
        fs.hint_seconds AS hint, fs.slowdown_seconds AS slowdown,
        r.min_interval_seconds AS site_minimum
      FROM feed_sources fs
      LEFT JOIN fetch_host_rules r ON r.host = ${sourceHost(sql`fs.url`)}
      WHERE fs.id = ANY(${sql.param(feedSourceIds)}::int[])`);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          base: r.base === null ? null : Math.max(MIN_INTERVAL_SECONDS, r.base),
          hint: r.hint,
          slowdown: r.slowdown,
          siteMinimum: r.site_minimum,
        },
      ]),
    );
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
    if (moved.rowCount) {
      // Feed URLs reach the logs only at debug.
      this.#logger.info(
        { feedSourceId: source.id, from: hostOf(source.url), to: hostOf(url) },
        'Feed moved',
      );
      this.#logger.debug({ feedSourceId: source.id, from: source.url, to: url }, 'Feed moved');
    }
  }

  /** Reschedules without counting a failure. */
  async #postpone(feedSourceId: number, seconds: number): Promise<void> {
    const delay = jittered(seconds);
    await this.#db
      .update(feedSources)
      .set({ nextFetchAt: sql`now() + make_interval(secs => ${delay})` })
      .where(eq(feedSources.id, feedSourceId));
  }

  /**
   * Backs off, and on a 429 (or 503 with Retry-After) raises the slowdown; the fetcher has paused
   * the host already.
   */
  async #recordFailure(source: FeedSourceRow, err: unknown): Promise<void> {
    if (!(err instanceof FetchError || err instanceof FeedParseError)) throw err;
    const failures = source.errorCount + 1;
    const gone = err instanceof FetchError && err.status === 410;
    const disable = gone || failures >= this.#settings.disableAfterFailures;
    let retryAfter = err instanceof FetchError ? err.retryAfterSeconds : null;
    const throttled = err instanceof FetchError && isHostThrottle(err);
    if (throttled) retryAfter ??= DEFAULT_HOST_COOLDOWN_SECONDS;
    const message =
      err instanceof FeedParseError ? `Not a valid feed: ${err.message}` : err.message;
    const inputs = await this.#inputsOf(source.id);
    const slowdown = throttled
      ? afterThrottle(source.slowdownSeconds, this.#interval({ ...inputs, slowdown: null }).seconds)
      : source.slowdownSeconds;
    const schedule = this.#interval({ ...inputs, slowdown });
    const delay = jittered(backoffSeconds(schedule.seconds, failures, retryAfter));
    await this.#db
      .update(feedSources)
      .set({
        errorCount: failures,
        lastError: message.slice(0, 1000),
        lastErrorAt: sql`now()`,
        lastFetchedAt: sql`now()`,
        fetchIntervalSeconds: schedule.seconds,
        fetchIntervalReason: schedule.reason,
        ...(throttled && { slowdownSeconds: slowdown, slowdownOkCount: 0 }),
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
