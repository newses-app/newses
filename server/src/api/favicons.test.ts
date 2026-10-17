import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { feedSources, subscriptions } from '../db/schema.ts';
import { faviconKey } from '../core/feeds/favicons.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { MemoryBlobStore } from '../test/fakes.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

const icon = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
const key = faviconKey(icon);

let database: TestDatabase;
let db: Db;
const blobs = new MemoryBlobStore();
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  const services = createTestServices(db, new FakeFetcher(), { blobs });
  const user = await services.users.create('fay', 'fay password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await blobs.put(key, icon);
  await blobs.put('favicons/unshown', icon);
  await blobs.put('images/secret', icon);
  const [source] = await db
    .insert(feedSources)
    .values({ url: 'https://icon.example/rss', faviconKey: key })
    .returning();
  await db.insert(subscriptions).values({ userId: user.id, feedSourceId: source?.id ?? 0 });
});

afterAll(async () => {
  await database.drop();
});

describe('feed icons', () => {
  it("are at the subscription's iconUrl, served without a session and cached for good", async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'fay', password: 'fay password' },
    });
    const cookie = `rss_session=${login.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`;
    const [subscription] = (
      await app.inject({ url: '/api/v1/subscriptions', headers: { cookie } })
    ).json<{ iconUrl: string | null }[]>();
    expect(subscription?.iconUrl).toBe(`/${key}`);

    const res = await app.inject({ url: subscription?.iconUrl ?? '' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect([...res.rawPayload]).toEqual([...icon.data]);
  });

  it('serves only icons a feed source shows', async () => {
    const missing = await app.inject({ url: `/favicons/${'0'.repeat(64)}` });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ url: '/favicons/unshown' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/favicons/..%2Fimages%2Fsecret' })).statusCode).toBe(400);
  });
});
