import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { feedSources, subscriptions, userEntries, userPrefs, users } from '../../db/schema.ts';
import { FakeFetcher, rss } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingQueue, testFeedDeps } from '../../test/fakes.ts';
import { FetchError } from './http.ts';
import { createFeedServices, type FeedServices } from './index.ts';
import { backoffSeconds, nextFetchSeconds } from './updater.ts';

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

describe('nextFetchSeconds', () => {
  it('honours publisher hints up to a day and adds up to 10% jitter', () => {
    expect(nextFetchSeconds(1800, [null, 600], 0)).toBe(1800);
    expect(nextFetchSeconds(1800, [7200, null], 0)).toBe(7200);
    expect(nextFetchSeconds(1800, [10 * 86_400], 0)).toBe(86_400);
    expect(nextFetchSeconds(1800, [], 1)).toBe(1980);
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
      { name: 'feed.fetch', data: { feedSourceId: due.id }, key: String(due.id) },
    ]);
    expect(await feeds.updater.dispatchDue()).toBe(0);
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
    const { fetchIntervalSeconds } = await source(created.id);
    expect(fetchIntervalSeconds).toBeGreaterThanOrEqual(300);
    expect(fetchIntervalSeconds).toBeLessThanOrEqual(330);
  });

  it("falls back to the user's preferred interval", async () => {
    fetcher.set(URL_A, { body: rss('A') });
    const created = await addSource(URL_A);
    await db.insert(userPrefs).values({ userId, key: 'updateIntervalMinutes', value: 120 });
    expect(await feeds.updater.intervalSeconds(created.id)).toBe(7200);
    await db.update(subscriptions).set({ updateIntervalSeconds: 900 });
    expect(await feeds.updater.intervalSeconds(created.id)).toBe(900);
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
    fetcher.set(URL_A, { body: rss('A'), redirectTo: moved, permanent: true });
    const created = await addSource(URL_A);
    await feeds.updater.update(created.id);
    expect((await source(created.id)).url).toBe(moved);

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
    await feeds.updater.update(second.id);
    expect(fetcher.requested).toEqual(['https://busy.example/a']);
    const postponed = await source(second.id);
    expect(postponed.errorCount).toBe(0);
    expect(secondsUntil(postponed.nextFetchAt)).toBeGreaterThan(500);
    expect((await source(first.id)).blockedUntil).not.toBeNull();
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
      { name: 'feed.fetch', data: { feedSourceId: created.id }, key: String(created.id) },
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

  it('skips disabled sources', async () => {
    const created = await addSource(URL_A);
    await db.update(feedSources).set({ disabledAt: sql`now()` });
    await feeds.updater.update(created.id);
    expect(fetcher.requested).toEqual([]);
  });
});
