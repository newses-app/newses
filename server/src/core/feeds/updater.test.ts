import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  feedSources,
  fetchHostRules,
  fetchHosts,
  subscriptions,
  userEntries,
  userPrefs,
  users,
} from '../../db/schema.ts';
import { FakeFetcher, rss } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingQueue, testFeedDeps } from '../../test/fakes.ts';
import { FetchError } from './http.ts';
import { createFeedServices, type FeedServices } from './index.ts';
import { backoffSeconds, hintSeconds } from './updater.ts';

let database: TestDatabase;
let db: Db;
let fetcher: FakeFetcher;
let queue: RecordingQueue;
let feeds: FeedServices;
let userId: number;

const URL_A = 'https://a.example/rss';

async function addSource(url: string, subscribe = true) {
  const [source] = await db.insert(feedSources).values({ url }).returning();
  if (!source) throw new Error('no source');
  if (subscribe) await db.insert(subscriptions).values({ userId, feedSourceId: source.id });
  return source;
}

async function source(id: number) {
  const [row] = await db.select().from(feedSources).where(eq(feedSources.id, id));
  if (!row) throw new Error('no source');
  return row;
}

const secondsUntil = (date: Date) => Math.round((date.getTime() - Date.now()) / 1000);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  await db.delete(fetchHosts);
  fetcher = new FakeFetcher();
  queue = new RecordingQueue();
  feeds = createFeedServices(testFeedDeps(db, fetcher, { queue }));
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('backoffSeconds', () => {
  it('doubles per failure, caps at a day, and honours Retry-After', () => {
    expect([1, 2, 3, 6, 10].map((n) => backoffSeconds(1800, n, null))).toEqual([
      1800, 3600, 7200, 57600, 86400,
    ]);
    expect(backoffSeconds(1800, 1, 7200)).toBe(7200);
  });
});

describe('hintSeconds', () => {
  it('takes the longest hint, capped at a day', () => {
    expect(hintSeconds([null, 600])).toBe(600);
    expect(hintSeconds([7200, 600])).toBe(7200);
    expect(hintSeconds([10 * 86_400])).toBe(86_400);
    expect(hintSeconds([null, 0])).toBeNull();
  });
});

describe('FeedUpdater.dispatchDue', () => {
  it('claims due, enabled, subscribed sources once', async () => {
    const due = await addSource(URL_A);
    await addSource('https://unsubscribed.example/rss', false);
    const disabled = await addSource('https://disabled.example/rss');
    await db
      .update(feedSources)
      .set({ disabledAt: new Date() })
      .where(eq(feedSources.id, disabled.id));
    const later = await addSource('https://later.example/rss');
    await db
      .update(feedSources)
      .set({ nextFetchAt: new Date(Date.now() + 60_000) })
      .where(eq(feedSources.id, later.id));

    expect(await feeds.updater.dispatchDue()).toBe(1);
    expect(queue.jobs).toEqual([
      { name: 'feed.fetch', data: { feedSourceIds: [due.id] }, key: 'a.example' },
    ]);
    expect(await feeds.updater.dispatchDue()).toBe(0);
  });

  it('skips sources whose subscriptions are all paused', async () => {
    const paused = await addSource(URL_A);
    await db.update(subscriptions).set({ paused: true });
    expect(await feeds.updater.dispatchDue()).toBe(0);
    const [other] = await db
      .insert(users)
      .values({ login: 'bob', passwordHash: 'x' })
      .returning({ id: users.id });
    await db.insert(subscriptions).values({ userId: other?.id ?? 0, feedSourceId: paused.id });
    expect(await feeds.updater.dispatchDue()).toBe(1);
  });

  it('batches sources by host, at most 20 per job', async () => {
    const many = [];
    for (let i = 0; i < 22; i++) many.push(await addSource(`https://big.example/${String(i)}`));
    const other = await addSource('https://other.example:8443/rss');

    expect(await feeds.updater.dispatchDue()).toBe(21);
    expect(queue.jobs).toEqual([
      {
        name: 'feed.fetch',
        data: { feedSourceIds: many.slice(0, 20).map((s) => s.id) },
        key: 'big.example',
      },
      { name: 'feed.fetch', data: { feedSourceIds: [other.id] }, key: 'other.example:8443' },
    ]);
  });

  it("leaves sources due when their host's job is already queued", async () => {
    const first = await addSource(URL_A);
    await feeds.updater.dispatchDue();
    const second = await addSource('https://a.example/other');
    expect(await feeds.updater.dispatchDue()).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(secondsUntil((await source(second.id)).nextFetchAt)).toBeLessThanOrEqual(0);
    expect(secondsUntil((await source(first.id)).nextFetchAt)).toBeGreaterThan(800);
  });
});

describe('FeedUpdater.update', () => {
  it('ingests, records validators, schedules the next fetch, and requests the icon', async () => {
    fetcher.set(URL_A, {
      body: rss('Feed A', 'https://a.example/', [{ guid: '1', title: 'Hello' }]),
      etag: '"v1"',
    });
    const created = await addSource(URL_A);
    await feeds.updater.update(created.id);

    const after = await source(created.id);
    expect(after).toMatchObject({
      title: 'Feed A',
      siteUrl: 'https://a.example/',
      etag: '"v1"',
      errorCount: 0,
    });
    expect(secondsUntil(after.nextFetchAt)).toBeGreaterThan(1700);
    expect(await db.select().from(userEntries)).toHaveLength(1);
    expect(queue.jobs.map((j) => j.name)).toEqual(['feed.favicon']);

    await feeds.updater.update(created.id);
    expect((await source(created.id)).etag).toBe('"v1"');
  });

  it('uses the shortest subscriber interval, at least five minutes', async () => {
    fetcher.set(URL_A, { body: rss('A') });
    const created = await addSource(URL_A);
    await db.update(subscriptions).set({ updateIntervalSeconds: 60 });
    await feeds.updater.update(created.id);
    const after = await source(created.id);
    expect(after).toMatchObject({ fetchIntervalSeconds: 300, fetchIntervalReason: 'subscribers' });
    expect(secondsUntil(after.nextFetchAt)).toBeLessThanOrEqual(330);
  });

  it("falls back to the user's preferred interval, leaving out paused subscriptions", async () => {
    fetcher.set(URL_A, { body: rss('A') });
    const created = await addSource(URL_A);
    await db.insert(userPrefs).values({ userId, key: 'updateIntervalMinutes', value: 120 });
    expect(await feeds.updater.schedule(created.id)).toEqual({
      seconds: 7200,
      reason: 'subscribers',
    });
    expect(await feeds.updater.userIntervalSeconds(userId)).toBe(7200);
    await db.update(subscriptions).set({ updateIntervalSeconds: 900 });
    expect((await feeds.updater.schedule(created.id)).seconds).toBe(900);
    await db.update(subscriptions).set({ paused: true });
    expect((await feeds.updater.schedule(created.id)).reason).toBe('unscheduled');
  });

  it("applies the site's minimum interval to every feed of the host", async () => {
    fetcher.set(URL_A, { body: rss('A') });
    const created = await addSource(URL_A);
    await feeds.hostRules.set('A.example', 6 * 3600, userId);
    expect(await feeds.updater.schedule(created.id)).toEqual({
      seconds: 6 * 3600,
      reason: 'siteMinimum',
    });
    await feeds.updater.update(created.id);
    expect(secondsUntil((await source(created.id)).nextFetchAt)).toBeGreaterThan(6 * 3600 - 60);
    await feeds.hostRules.clear('a.example');
    expect(await db.select().from(fetchHostRules)).toEqual([]);
    expect((await source(created.id)).fetchIntervalReason).toBe('subscribers');
  });

  it('waits longer when the publisher asks via Cache-Control or ttl', async () => {
    fetcher.set(URL_A, { body: rss('A'), maxAge: 4 * 3600 });
    const created = await addSource(URL_A);
    await feeds.updater.update(created.id);
    expect(secondsUntil((await source(created.id)).nextFetchAt)).toBeGreaterThan(4 * 3600 - 60);

    fetcher.set(URL_A, { body: rss('A').replace('<description>', '<ttl>120</ttl><description>') });
    await feeds.updater.update(created.id);
    const row = await source(created.id);
    expect(row.ttlSeconds).toBe(7200);
    expect(secondsUntil(row.nextFetchAt)).toBeGreaterThan(7100);
  });

  it('adopts the URL of a permanent redirect unless another source has it', async () => {
    const moved = 'https://new.example/rss';
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    feeds = createFeedServices(testFeedDeps(db, fetcher, { queue, logger }));
    fetcher.set(URL_A, { body: rss('A'), redirectTo: moved, permanent: true });
    const created = await addSource(URL_A);
    await feeds.updater.update(created.id);
    expect((await source(created.id)).url).toBe(moved);
    // Feed URLs are logged only at debug.
    const moves = { feedSourceId: created.id, from: 'a.example', to: 'new.example' };
    expect(logger.info).toHaveBeenCalledWith(moves, 'Feed moved');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(URL_A);
    expect(logger.debug).toHaveBeenCalledWith({ ...moves, from: URL_A, to: moved }, 'Feed moved');

    const other = await addSource('https://old.example/rss');
    fetcher.set('https://old.example/rss', { body: rss('A'), redirectTo: moved, permanent: true });
    await feeds.updater.update(other.id);
    expect((await source(other.id)).url).toBe('https://old.example/rss');
  });

  it('leaves every feed of a host alone after it answers 429', async () => {
    const first = await addSource('https://busy.example/a');
    const second = await addSource('https://busy.example/b');
    fetcher.set(
      'https://busy.example/a',
      new FetchError('http_status', 'HTTP 429', { status: 429 }),
    );
    fetcher.set('https://busy.example/b', { body: rss('B') });
    await feeds.updater.update(first.id);
    // Another process sees the host's cooldown too.
    const other = createFeedServices(testFeedDeps(db, fetcher, { queue }));
    await other.updater.updateMany([second.id]);
    expect(fetcher.requested).toEqual(['https://busy.example/a']);
    const postponed = await source(second.id);
    expect(postponed.errorCount).toBe(0);
    expect(secondsUntil(postponed.nextFetchAt)).toBeGreaterThan(500);
    expect((await source(first.id)).blockedUntil).not.toBeNull();
  });

  it('slows a feed down after each 429 and eases back after successful fetches', async () => {
    const created = await addSource(URL_A);
    const throttle = new FetchError('http_status', 'HTTP 429', { status: 429 });
    fetcher.set(URL_A, throttle);
    await feeds.updater.update(created.id);
    expect(await source(created.id)).toMatchObject({
      slowdownSeconds: 3600,
      fetchIntervalSeconds: 3600,
      fetchIntervalReason: 'slowdown',
    });
    await db.delete(fetchHosts);
    await feeds.updater.update(created.id);
    expect((await source(created.id)).slowdownSeconds).toBe(7200);

    await db.delete(fetchHosts);
    fetcher.set(URL_A, { body: rss('A') });
    for (let i = 0; i < 4; i++) await feeds.updater.update(created.id);
    expect(await source(created.id)).toMatchObject({
      slowdownSeconds: 7200,
      slowdownOkCount: 4,
      fetchIntervalReason: 'slowdown',
      errorCount: 0,
    });
    await feeds.updater.update(created.id);
    expect(await source(created.id)).toMatchObject({ slowdownSeconds: 3600, slowdownOkCount: 0 });
  });

  it('backs off on failures and disables after the configured count', async () => {
    const created = await addSource(URL_A);
    fetcher.set(URL_A, new FetchError('http_status', 'HTTP 500', { status: 500 }));
    await feeds.updater.update(created.id);
    let row = await source(created.id);
    expect(row).toMatchObject({ errorCount: 1, lastError: 'HTTP 500', disabledAt: null });
    expect(secondsUntil(row.nextFetchAt)).toBeGreaterThan(1700);

    fetcher.set(URL_A, { body: 'not a feed', contentType: 'text/plain' });
    await feeds.updater.update(created.id);
    row = await source(created.id);
    expect(row.errorCount).toBe(2);
    expect(row.lastError).toMatch(/^Not a valid feed/);
    expect(secondsUntil(row.nextFetchAt)).toBeGreaterThan(3500);

    await feeds.updater.update(created.id);
    expect((await source(created.id)).disabledAt).not.toBeNull();
  });

  it('honours Retry-After and disables on HTTP 410', async () => {
    const busy = await addSource(URL_A);
    fetcher.set(
      URL_A,
      new FetchError('http_status', 'HTTP 429', { status: 429, retryAfterSeconds: 20_000 }),
    );
    await feeds.updater.update(busy.id);
    expect(secondsUntil((await source(busy.id)).nextFetchAt)).toBeGreaterThan(19_000);

    const gone = await addSource('https://gone.example/rss');
    fetcher.set(
      'https://gone.example/rss',
      new FetchError('http_status', 'HTTP 410', { status: 410 }),
    );
    await feeds.updater.update(gone.id);
    expect((await source(gone.id)).disabledAt).not.toBeNull();
  });

  it('re-enables and enqueues a feed on manual refresh', async () => {
    const created = await addSource(URL_A);
    await db.update(feedSources).set({ disabledAt: new Date(), errorCount: 9 });
    const [sub] = await db.select().from(subscriptions);
    await feeds.updater.refresh(userId, sub?.id ?? 0);
    expect(await source(created.id)).toMatchObject({ disabledAt: null, errorCount: 0 });
    expect(queue.jobs).toEqual([
      { name: 'feed.fetch', data: { feedSourceIds: [created.id] }, key: 'a.example' },
    ]);
    await expect(feeds.updater.refresh(userId + 999, sub?.id ?? 0)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses while the host asked to wait, and skips feeds fetched within a minute', async () => {
    fetcher.set(URL_A, { body: rss('A') });
    const created = await addSource(URL_A);
    const [sub] = await db.select().from(subscriptions);
    await db
      .update(feedSources)
      .set({ blockedUntil: new Date(Date.now() + 600_000) })
      .where(eq(feedSources.id, created.id));
    await expect(feeds.updater.refresh(userId, sub?.id ?? 0)).rejects.toMatchObject({
      code: 'throttled',
    });

    await feeds.updater.update(created.id);
    queue.jobs.length = 0;
    await feeds.updater.refresh(userId, sub?.id ?? 0);
    expect(queue.jobs).toEqual([]);
  });

  it('runs a manual refresh of a feed whose subscriptions are all paused', async () => {
    const created = await addSource(URL_A);
    await db.update(subscriptions).set({ paused: true });
    const [sub] = await db.select().from(subscriptions);
    await feeds.updater.refresh(userId, sub?.id ?? 0);
    expect(queue.jobs).toEqual([
      { name: 'feed.fetch', data: { feedSourceIds: [created.id] }, key: 'a.example' },
    ]);
  });

  it('skips disabled sources', async () => {
    const created = await addSource(URL_A);
    await db.update(feedSources).set({ disabledAt: sql`now()` });
    await feeds.updater.update(created.id);
    expect(fetcher.requested).toEqual([]);
  });
});

describe('FeedUpdater.reschedule', () => {
  async function fetched(lastMinutesAgo: number, nextInMinutes: number) {
    const created = await addSource(URL_A);
    await db
      .update(feedSources)
      .set({
        lastFetchedAt: new Date(Date.now() - lastMinutesAgo * 60_000),
        nextFetchAt: new Date(Date.now() + nextInMinutes * 60_000),
        fetchIntervalSeconds: 7 * 86_400,
      })
      .where(eq(feedSources.id, created.id));
    return created;
  }

  it('brings a shortened interval forward, but not before now', async () => {
    const created = await fetched(60, 7 * 24 * 60 - 60);
    await db.update(subscriptions).set({ updateIntervalSeconds: 2 * 3600 });
    await feeds.updater.reschedule([created.id]);
    const after = await source(created.id);
    expect(after.fetchIntervalSeconds).toBe(7200);
    expect(secondsUntil(after.nextFetchAt)).toBeGreaterThan(3500);
    expect(secondsUntil(after.nextFetchAt)).toBeLessThan(4400);

    await db.update(subscriptions).set({ updateIntervalSeconds: 15 * 60 });
    await feeds.updater.reschedule([created.id]);
    expect(Math.abs(secondsUntil((await source(created.id)).nextFetchAt))).toBeLessThan(5);
  });

  it('pushes a lengthened interval back', async () => {
    const created = await fetched(10, 20);
    await db.update(subscriptions).set({ updateIntervalSeconds: 86_400 });
    await feeds.updater.reschedule([created.id]);
    expect(secondsUntil((await source(created.id)).nextFetchAt)).toBeGreaterThan(86_000 - 600);
  });

  it('leaves claimed, failing, and never fetched sources at their time', async () => {
    const claimed = await fetched(60, 10);
    await feeds.updater.reschedule([claimed.id]);
    expect(secondsUntil((await source(claimed.id)).nextFetchAt)).toBeGreaterThan(500);

    await db.update(feedSources).set({ nextFetchAt: new Date(Date.now() + 86_400_000) });
    await db.update(feedSources).set({ errorCount: 2 });
    await feeds.updater.reschedule([claimed.id]);
    expect(secondsUntil((await source(claimed.id)).nextFetchAt)).toBeGreaterThan(86_000);
  });

  it('follows changes to subscriptions and the default interval', async () => {
    const created = await fetched(60, 7 * 24 * 60);
    const [sub] = await db.select().from(subscriptions);
    await feeds.subscriptions.update(userId, sub?.id ?? 0, { updateIntervalSeconds: 3600 });
    expect(Math.abs(secondsUntil((await source(created.id)).nextFetchAt))).toBeLessThan(400);

    await feeds.subscriptions.update(userId, sub?.id ?? 0, { paused: true });
    expect((await source(created.id)).fetchIntervalReason).toBe('unscheduled');

    await feeds.subscriptions.update(userId, sub?.id ?? 0, {
      paused: false,
      updateIntervalSeconds: null,
    });
    await db.insert(userPrefs).values({ userId, key: 'updateIntervalMinutes', value: 240 });
    await feeds.updater.rescheduleUser(userId);
    expect((await source(created.id)).fetchIntervalSeconds).toBe(4 * 3600);
  });
});

describe('FeedUpdater.updateMany', () => {
  /** Answers after a delay, recording the most requests to one host in flight at once. */
  class SlowFetcher extends FakeFetcher {
    inFlight = 0;
    peak = 0;
    override async fetch(...args: Parameters<FakeFetcher['fetch']>) {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return await super.fetch(...args);
      } finally {
        this.inFlight -= 1;
      }
    }
  }

  async function lease() {
    const [row] = await db.select().from(fetchHosts).where(eq(fetchHosts.host, 'many.example'));
    return row;
  }

  it("never lets two processes work through a host's feeds at once", async () => {
    const slow = new SlowFetcher();
    const sources = [];
    for (const n of [1, 2, 3, 4]) {
      const url = `https://many.example/${String(n)}`;
      slow.set(url, { body: rss(`Feed ${String(n)}`) });
      sources.push(await addSource(url));
    }
    const ids = sources.map((s) => s.id);
    // Two processes, each with its own in-process limiter.
    const first = createFeedServices(testFeedDeps(db, slow, { queue }));
    const second = createFeedServices(testFeedDeps(db, slow, { queue }));
    await Promise.all([
      first.updater.updateMany(ids.slice(0, 2)),
      second.updater.updateMany(ids.slice(2)),
    ]);
    expect(slow.peak).toBe(1);
    // The job that found the host held waits, its sources still claimed.
    expect(slow.requested).toHaveLength(2);
    expect(queue.jobs).toContainEqual(
      expect.objectContaining({ name: 'feed.fetch', key: 'many.example', delaySeconds: 60 }),
    );
    const waiting = (queue.jobs.find((j) => j.name === 'feed.fetch')?.data ?? {}) as {
      feedSourceIds: number[];
    };
    for (const id of waiting.feedSourceIds)
      expect(secondsUntil((await source(id)).nextFetchAt)).toBeGreaterThan(14 * 60);
    // The finished job let go of the host.
    expect((await lease())?.leaseId).toBeNull();
  });

  it('takes over a lease its holder let lapse', async () => {
    const created = await addSource('https://many.example/1');
    fetcher.set('https://many.example/1', { body: rss('A') });
    await db.insert(fetchHosts).values({
      host: 'many.example',
      leaseId: '00000000-0000-4000-8000-000000000000',
      leasedUntil: new Date(Date.now() - 1000),
    });
    await feeds.updater.updateMany([created.id]);
    expect(fetcher.requested).toEqual(['https://many.example/1']);
    expect((await lease())?.leaseId).toBeNull();
  });

  it('leaves sources due when another job already waits for the host', async () => {
    const created = await addSource('https://many.example/1');
    await db.insert(fetchHosts).values({
      host: 'many.example',
      leaseId: '00000000-0000-4000-8000-000000000000',
      leasedUntil: new Date(Date.now() + 60_000),
    });
    await queue.enqueue('feed.fetch', { feedSourceIds: [created.id] }, { key: 'many.example' });
    await feeds.updater.updateMany([created.id]);
    expect(fetcher.requested).toEqual([]);
    expect(secondsUntil((await source(created.id)).nextFetchAt)).toBeLessThanOrEqual(0);
  });

  it("keeps a host's pause while holding its lease", async () => {
    const created = await addSource('https://many.example/1');
    fetcher.set('https://many.example/1', { body: rss('A') });
    await db.insert(fetchHosts).values({
      host: 'many.example',
      blockedUntil: new Date(Date.now() + 600_000),
    });
    await feeds.updater.updateMany([created.id]);
    expect(fetcher.requested).toEqual([]);
    const row = await lease();
    expect(row?.blockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(row?.leaseId).toBeNull();
    expect((await source(created.id)).errorCount).toBe(0);
  });
});
