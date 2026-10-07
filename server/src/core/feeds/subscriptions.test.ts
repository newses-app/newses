import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { entries, feedSources, userEntries, users } from '../../db/schema.ts';
import { FakeFetcher, htmlPage, rss } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { CategoryService } from '../categories.ts';
import { testFeedDeps } from '../../test/fakes.ts';
import { FetchError } from './http.ts';
import { createFeedServices } from './index.ts';
import { SubscriptionService } from './subscriptions.ts';

let database: TestDatabase;
let db: Db;
let fetcher: FakeFetcher;
let service: SubscriptionService;
let userId: number;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  fetcher = new FakeFetcher();
  service = new SubscriptionService(db, fetcher);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('SubscriptionService.subscribe', () => {
  it('subscribes to a feed URL and records the feed title', async () => {
    fetcher.set('https://news.example/rss', { body: rss('News', 'https://news.example/') });
    const result = await service.subscribe(userId, 'news.example/rss');
    expect(result.status).toBe('subscribed');
    if (result.status !== 'subscribed') return;
    expect(result.subscription.source).toMatchObject({
      url: 'https://news.example/rss',
      title: 'News',
      siteUrl: 'https://news.example/',
    });
  });

  it('stores the URL reached after redirects', async () => {
    fetcher.set('http://old.example/feed', {
      body: rss('Moved'),
      redirectTo: 'https://new.example/feed',
    });
    const result = await service.subscribe(userId, 'http://old.example/feed');
    expect(result.status === 'subscribed' && result.subscription.source.url).toBe(
      'https://new.example/feed',
    );
  });

  it('follows a single advertised feed on a web page', async () => {
    fetcher
      .set('https://blog.example/', {
        body: htmlPage({ href: '/feed.xml' }),
        contentType: 'text/html',
      })
      .set('https://blog.example/feed.xml', { body: rss('Blog') });
    const result = await service.subscribe(userId, 'https://blog.example/');
    expect(result.status === 'subscribed' && result.subscription.source.url).toBe(
      'https://blog.example/feed.xml',
    );
  });

  it('asks the user to choose when a page advertises several feeds', async () => {
    fetcher.set('https://multi.example/', {
      body: htmlPage(
        { href: '/posts.xml', title: 'Posts' },
        { href: '/comments.xml', title: 'Comments' },
      ),
      contentType: 'text/html',
    });
    expect(await service.subscribe(userId, 'https://multi.example/')).toEqual({
      status: 'choose',
      candidates: [
        { url: 'https://multi.example/posts.xml', title: 'Posts', type: 'application/rss+xml' },
        {
          url: 'https://multi.example/comments.xml',
          title: 'Comments',
          type: 'application/rss+xml',
        },
      ],
    });
  });

  it('reuses a known feed source without fetching, and rejects duplicates', async () => {
    const [bob] = await db.insert(users).values({ login: 'bob', passwordHash: 'x' }).returning();
    fetcher.set('https://shared.example/rss', { body: rss('Shared') });
    await service.subscribe(userId, 'https://shared.example/rss');
    await service.subscribe(bob?.id ?? 0, 'https://shared.example/rss');
    expect(fetcher.requested).toEqual(['https://shared.example/rss']);
    await expect(service.subscribe(userId, 'https://shared.example/rss')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('maps failures to domain errors', async () => {
    fetcher
      .set('https://plain.example/', {
        body: '<html><body>no feeds</body></html>',
        contentType: 'text/html',
      })
      .set(
        'https://private.example/',
        new FetchError('blocked_address', 'private.example resolves to a private address'),
      );
    await expect(service.subscribe(userId, 'https://plain.example/')).rejects.toMatchObject({
      code: 'feed_not_found',
    });
    await expect(service.subscribe(userId, 'https://missing.example/')).rejects.toMatchObject({
      code: 'fetch_failed',
    });
    await expect(service.subscribe(userId, 'https://private.example/')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(service.subscribe(userId, 'gopher://x')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it("rejects another user's category", async () => {
    const [bob] = await db.insert(users).values({ login: 'bob', passwordHash: 'x' }).returning();
    const category = await new CategoryService(db).create(bob?.id ?? 0, 'Bob');
    fetcher.set('https://x.example/rss', { body: rss('X') });
    await expect(
      service.subscribe(userId, 'https://x.example/rss', category.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('SubscriptionService.unsubscribe', () => {
  it('keeps starred, published, and noted entries and removes the rest', async () => {
    fetcher.set('https://u.example/rss', { body: rss('U') });
    const result = await service.subscribe(userId, 'https://u.example/rss');
    if (result.status !== 'subscribed') throw new Error('expected subscription');
    const { subscription, source } = result.subscription;
    const made = await db
      .insert(entries)
      .values(
        ['a', 'b', 'c', 'd'].map((guid) => ({ feedSourceId: source.id, guid, contentHash: guid })),
      )
      .returning();
    await db.insert(userEntries).values(
      made.map((entry, i) => ({
        userId,
        entryId: entry.id,
        subscriptionId: subscription.id,
        sortAt: new Date(),
        starred: i === 0,
        published: i === 1,
        note: i === 2 ? 'keep' : null,
      })),
    );

    await service.unsubscribe(userId, subscription.id);
    const kept = await db.select().from(userEntries);
    expect(kept.map((e) => [e.starred, e.published, e.note, e.subscriptionId])).toEqual(
      expect.arrayContaining([
        [true, false, null, null],
        [false, true, null, null],
        [false, false, 'keep', null],
      ]),
    );
    expect(kept).toHaveLength(3);
    await expect(service.unsubscribe(userId, subscription.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('subscribing with the updater', () => {
  it('ingests the validating fetch instead of fetching the new feed again', async () => {
    const feeds = createFeedServices(testFeedDeps(db, fetcher));
    fetcher.set('https://fresh.example/rss', {
      body: rss('Fresh', 'https://fresh.example/', [{ guid: '1', title: 'One' }]),
      etag: '"e"',
    });
    const result = await feeds.subscriptions.subscribe(userId, 'https://fresh.example/rss');
    expect(result.status === 'subscribed' && result.subscription.source).toMatchObject({
      etag: '"e"',
    });
    expect(await db.select().from(userEntries)).toHaveLength(1);
    expect(await feeds.updater.dispatchDue()).toBe(0);
    expect(fetcher.requested).toEqual(['https://fresh.example/rss']);
  });
});
