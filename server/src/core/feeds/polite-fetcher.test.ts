import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { feedSources, fetchHosts, users } from '../../db/schema.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { testFeedDeps } from '../../test/fakes.ts';
import { ThrottledError } from '../errors.ts';
import { HostLimiter } from './host-limiter.ts';
import { FetchError } from './http.ts';
import { createFeedServices } from './index.ts';
import { PoliteFetcher } from './polite-fetcher.ts';

let database: TestDatabase;
let db: Db;
let fake: FakeFetcher;
let polite: PoliteFetcher;

const throttle = (status: number, retryAfterSeconds: number | null, url?: string) =>
  new FetchError('http_status', `HTTP ${String(status)}`, {
    status,
    retryAfterSeconds,
    ...(url && { url }),
  });

async function blockedHosts() {
  return (await db.select({ host: fetchHosts.host }).from(fetchHosts)).map((r) => r.host).sort();
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(fetchHosts);
  await db.delete(feedSources);
  await db.delete(users);
  fake = new FakeFetcher();
  polite = new PoliteFetcher({ db, fetcher: fake, hosts: new HostLimiter(2) });
});

afterAll(async () => {
  await database.drop();
});

describe('PoliteFetcher', () => {
  it('pauses the host on a 429 from any fetch, and asks it nothing until then', async () => {
    fake.set('https://img.example/a.png', throttle(429, 120));
    await expect(polite.fetch('https://img.example/a.png', { purpose: 'image' })).rejects.toThrow(
      'HTTP 429',
    );
    expect(await blockedHosts()).toEqual(['img.example']);
    expect(await polite.blockedSeconds('img.example')).toBeGreaterThan(100);

    fake.set('https://img.example/b.png', { body: 'x' });
    const blocked = await polite.fetch('https://img.example/b.png').catch((err: unknown) => err);
    expect(blocked).toBeInstanceOf(FetchError);
    expect(blocked).toMatchObject({ code: 'host_blocked' });
    expect((blocked as FetchError).retryAfterSeconds).toBeGreaterThan(100);
    expect(fake.requested).toEqual(['https://img.example/a.png']);
  });

  it('pauses for a 503 only with Retry-After, and leaves other failures alone', async () => {
    fake.set('https://a.example/', throttle(503, null));
    fake.set('https://b.example/', throttle(503, 60));
    fake.set('https://c.example/', throttle(500, 60));
    for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/'])
      await polite.fetch(url).catch(() => undefined);
    expect(await blockedHosts()).toEqual(['b.example']);
  });

  it('pauses for 10 minutes when a 429 gives no Retry-After', async () => {
    fake.set('https://a.example/', throttle(429, null));
    await polite.fetch('https://a.example/').catch(() => undefined);
    const seconds = await polite.blockedSeconds('a.example');
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  it('pauses the host that answered, after redirects', async () => {
    fake.set('https://short.example/x', throttle(429, 60, 'https://cdn.example/x'));
    await polite.fetch('https://short.example/x').catch(() => undefined);
    expect(await blockedHosts()).toEqual(['cdn.example']);
  });
});

describe('services behind the polite fetcher', () => {
  async function pause(host: string) {
    await db.insert(fetchHosts).values({ host, blockedUntil: new Date(Date.now() + 600_000) });
  }

  it('refuse to subscribe to a paused host, saying when to try again', async () => {
    const feeds = createFeedServices(testFeedDeps(db, fake));
    const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
    await pause('paused.example');
    const failure = await feeds.subscriptions
      .subscribe(user?.id ?? 0, 'https://paused.example/rss')
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ThrottledError);
    expect((failure as ThrottledError).retryAfterSeconds).toBeGreaterThan(500);
    expect(fake.requested).toEqual([]);
  });

  it("leave a paused site's icon unchecked, so it is asked again later", async () => {
    const feeds = createFeedServices(testFeedDeps(db, fake));
    const [source] = await db
      .insert(feedSources)
      .values({ url: 'https://paused.example/rss', siteUrl: 'https://paused.example/' })
      .returning();
    await pause('paused.example');
    await feeds.favicons.refresh(source?.id ?? 0);
    const [row] = await db
      .select({ checked: feedSources.faviconCheckedAt })
      .from(feedSources)
      .where(eq(feedSources.id, source?.id ?? 0));
    expect(row?.checked).toBeNull();
    expect(fake.requested).toEqual([]);
  });
});
