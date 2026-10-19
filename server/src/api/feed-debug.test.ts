import type { FeedDebug } from '@newses/shared';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FETCH_LIMITS } from '../core/rate-limit.ts';
import { createDb, type Db } from '../db/client.ts';
import { entries, feedSources, fetchHosts, rateLimits } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, htmlPage, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

const FEED = 'https://news.example/rss';
const items = [
  { guid: 'a', title: 'Rust 2.0 released', link: 'https://news.example/a', description: 'Fast' },
  { guid: 'b', title: 'Gardening tips', link: 'https://news.example/b', description: 'Green' },
];

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
const fetcher = new FakeFetcher();
let alice: Record<string, string>;
let bob: Record<string, string>;
let subscriptionId = 0;
let rustFilter = 0;

async function signIn(login: string) {
  await services.users.create(login, `${login} password`);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: `${login} password` },
  });
  return {
    cookie: `rss_session=${res.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
    'x-csrf-token': res.json<{ csrfToken: string }>().csrfToken,
  };
}

const debug = (headers: Record<string, string>, id = subscriptionId) =>
  app.inject({ method: 'POST', url: `/api/v1/subscriptions/${String(id)}/debug`, headers });

const sourceState = async () => {
  const [row] = await db
    .select({
      etag: feedSources.etag,
      last: feedSources.lastFetchedAt,
      next: feedSources.nextFetchAt,
    })
    .from(feedSources)
    .where(eq(feedSources.url, FEED));
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(entries);
  return { ...row, entries: count?.n };
};

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher);
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  alice = await signIn('alice');
  bob = await signIn('bob');
  fetcher.set(FEED, { body: rss('News', 'https://news.example/', items.slice(0, 1)) });
  const subscribed = await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers: alice,
    payload: { url: FEED },
  });
  subscriptionId = subscribed.json<{ subscription: { id: number } }>().subscription.id;
  const filter = await app.inject({
    method: 'POST',
    url: '/api/v1/filters',
    headers: alice,
    payload: {
      title: 'Rust',
      rules: [{ field: 'title', pattern: 'rust' }],
      actions: [{ type: 'star' }],
    },
  });
  rustFilter = filter.json<{ id: number }>().id;
});

beforeEach(async () => {
  await db.delete(rateLimits);
  await db.delete(fetchHosts);
  fetcher.set(FEED, { body: rss('News', 'https://news.example/', items), etag: '"v2"' });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('feed debugger', () => {
  it('shows the answer and the entries with their filters, storing nothing', async () => {
    const before = await sourceState();
    const response = await debug(alice);
    expect(response.statusCode).toBe(200);
    const result = response.json<FeedDebug>();
    expect(result.error).toBeNull();
    expect(result.response).toMatchObject({ status: 200, url: FEED, truncated: false });
    expect(result.response?.headers).toContainEqual({ name: 'etag', value: '"v2"' });
    expect(result.response?.body).toContain('Gardening tips');
    expect(result.feed).toMatchObject({ format: 'rss', title: 'News' });
    expect(result.entries.map((e) => [e.guid, e.filterIds])).toEqual([
      ['a', [rustFilter]],
      ['b', []],
    ]);
    expect(await sourceState()).toEqual(before);
  });

  it("shows a broken feed's answer, and the feeds a page advertises", async () => {
    fetcher.set(FEED, { status: 404, body: '<h1>Not here</h1>', contentType: 'text/html' });
    const missing = (await debug(alice)).json<FeedDebug>();
    expect(missing.response).toMatchObject({ status: 404, body: '<h1>Not here</h1>' });
    expect(missing.feed).toBeNull();

    fetcher.set(FEED, {
      body: htmlPage({ href: 'https://news.example/feed.xml', title: 'Main' }),
      contentType: 'text/html',
    });
    const page = (await debug(alice)).json<FeedDebug>();
    expect(page.parseError).toEqual(expect.any(String));
    expect(page.discovered).toEqual([
      expect.objectContaining({ url: 'https://news.example/feed.xml', title: 'Main' }),
    ]);
  });

  it('says when the site asked to wait, without asking it', async () => {
    await db
      .insert(fetchHosts)
      .values({ host: 'news.example', blockedUntil: new Date(Date.now() + 600_000) });
    fetcher.requested.length = 0;
    const result = (await debug(alice)).json<FeedDebug>();
    expect(result.error).toMatchObject({ code: 'host_blocked' });
    expect(result.error?.retryAfterSeconds).toBeGreaterThan(500);
    expect(fetcher.requested).toEqual([]);
  });

  it("is only for the feed's subscriber, and rate limited", async () => {
    expect((await debug(bob)).statusCode).toBe(404);
    for (let n = 0; n < FETCH_LIMITS.debug; n++) expect((await debug(alice)).statusCode).toBe(200);
    const refused = await debug(alice);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});
