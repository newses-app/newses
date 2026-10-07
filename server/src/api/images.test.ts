import pino from 'pino';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { fetchHosts, imageCache } from '../db/schema.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { MemoryBlobStore } from '../test/fakes.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fetcher = new FakeFetcher()
  .set('https://pics.example/rss', {
    body: rss('Pics', 'https://pics.example/', [
      {
        guid: '1',
        title: 'Photo',
        description:
          '<p>Look</p><img src="https://img.example/cat.png"><img src="https://img.example/broken.png"><img src="https://img.example/p.gif" width="1" height="1">',
      },
    ]),
  })
  .set('https://img.example/cat.png', { body: PNG, contentType: 'application/octet-stream' })
  .set('https://img.example/broken.png', { body: '<html>nope</html>', contentType: 'text/html' });

let database: TestDatabase;
let db: Db;
let services: ApiServices;
const blobs = new MemoryBlobStore();
let app: ReturnType<typeof buildApp>;
let headers: Record<string, string>;

const content = async () => {
  const res = await app.inject({ url: '/api/v1/entries?content=true', headers });
  return res.json<{ entries: { content: string }[] }>().entries[0]?.content ?? '';
};
const imagePaths = (html: string) =>
  [...html.matchAll(/\/api\/v1\/images\/[^\s"]+/g)].map((m) => m[0]);
const requests = (url: string) => fetcher.requested.filter((u) => u === url).length;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher, { blobs });
  await services.users.create('ivy', 'ivy password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'ivy', password: 'ivy password' },
  });
  headers = {
    cookie: `rss_session=${login.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
  };
  const subscribed = await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers,
    payload: { url: 'https://pics.example/rss' },
  });
  expect(subscribed.statusCode).toBeLessThan(300);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('image proxy', () => {
  it('strips tracking pixels at ingest and proxies images only when the user opts in', async () => {
    const direct = await content();
    expect(direct).toContain('src="https://img.example/cat.png"');
    expect(direct).not.toContain('p.gif');
    expect(imagePaths(direct)).toEqual([]);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/prefs',
      headers,
      payload: { proxyImages: true },
    });
    const proxied = await content();
    expect(proxied).not.toContain('https://img.example/');
    expect(imagePaths(proxied)).toHaveLength(2);
  });

  it('serves signed images from the cache after one fetch', async () => {
    const [cat] = imagePaths(await content());
    const first = await app.inject({ url: cat ?? '' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['cache-control']).toBe('public, max-age=2592000, immutable');
    expect(first.headers['content-security-policy']).toContain('sandbox');
    expect([...first.rawPayload]).toEqual([...PNG]);
    // No session needed: the signature authorises the request.
    const anonymous = await app.inject({ url: cat ?? '' });
    expect(anonymous.statusCode).toBe(200);
    expect(requests('https://img.example/cat.png')).toBe(1);
  });

  it('refuses unsigned URLs and remembers failures', async () => {
    const [cat, broken] = imagePaths(await content());
    const [, , , , signature] = (cat ?? '').split('/');
    const evil = Buffer.from('http://169.254.169.254/latest/meta-data').toString('base64url');
    expect(
      (await app.inject({ url: `/api/v1/images/${signature ?? ''}/${evil}` })).statusCode,
    ).toBe(403);

    expect((await app.inject({ url: broken ?? '' })).statusCode).toBe(404);
    expect((await app.inject({ url: broken ?? '' })).statusCode).toBe(404);
    expect(requests('https://img.example/broken.png')).toBe(1);
  });

  it('does not fetch from a paused host', async () => {
    const path = services.feeds.images.path('https://paused.example/x.png');
    await db
      .insert(fetchHosts)
      .values({ host: 'paused.example', blockedUntil: sql`now() + interval '1 hour'` });
    expect((await app.inject({ url: path })).statusCode).toBe(404);
    expect(requests('https://paused.example/x.png')).toBe(0);
  });

  it('purges entries older than 30 days with their blobs', async () => {
    await db.update(imageCache).set({ fetchedAt: sql`now() - interval '31 days'` });
    expect(await services.feeds.images.purge()).toBe(2);
    expect([...blobs.blobs.keys()].filter((k) => k.startsWith('images/'))).toEqual([]);
  });
});
