import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { FakeFetcher, htmlPage, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let headers: Record<string, string>;
const fetcher = new FakeFetcher()
  .set('https://news.example/rss', { body: rss('News') })
  .set('https://multi.example/', {
    body: htmlPage({ href: '/a.xml' }, { href: '/b.xml' }),
    contentType: 'text/html',
  });

beforeAll(async () => {
  database = await createTestDatabase();
  const db = createDb(database.pool);
  const services = createTestServices(db, fetcher);
  await services.users.create('alice', 'alice password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password' },
  });
  const cookie = login.cookies.find((c) => c.name === 'rss_session')?.value ?? '';
  headers = {
    cookie: `rss_session=${cookie}`,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
  };
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('feeds API', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/subscriptions' })).statusCode).toBe(
      401,
    );
  });

  it('manages categories and subscriptions', async () => {
    const category = await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers,
      payload: { title: 'News' },
    });
    expect(category.statusCode).toBe(201);
    const categoryId = category.json<{ id: number }>().id;

    const subscribed = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers,
      payload: { url: 'news.example/rss', categoryId },
    });
    expect(subscribed.statusCode).toBe(201);
    const subscription = subscribed.json<{ subscription: { id: number } }>().subscription;
    expect(subscribed.json()).toMatchObject({
      status: 'subscribed',
      subscription: { title: 'News', url: 'https://news.example/rss', categoryId },
    });

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers,
      payload: { url: 'https://news.example/rss' },
    });
    expect(again.statusCode).toBe(409);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/subscriptions/${String(subscription.id)}`,
      headers,
      payload: { title: 'My news', categoryId: null },
    });
    expect(renamed.json()).toMatchObject({
      title: 'My news',
      customTitle: 'My news',
      categoryId: null,
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/subscriptions', headers });
    expect(list.json<unknown[]>()).toHaveLength(1);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/subscriptions/${String(subscription.id)}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('offers a choice of feeds and reports pages without feeds', async () => {
    const choose = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers,
      payload: { url: 'https://multi.example/' },
    });
    expect(choose.statusCode).toBe(200);
    expect(choose.json<{ candidates: unknown[] }>()).toMatchObject({ status: 'choose' });
    expect(choose.json<{ candidates: unknown[] }>().candidates).toHaveLength(2);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers,
      payload: { url: 'https://missing.example/' },
    });
    expect(missing.statusCode).toBe(502);
  });

  it('imports and exports OPML', async () => {
    const opml = `<?xml version="1.0"?><opml version="2.0"><head/><body>
      <outline text="Folder"><outline type="rss" text="F" xmlUrl="https://f.example/rss"/></outline>
    </body></opml>`;
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/opml',
      headers: { ...headers, 'content-type': 'text/x-opml' },
      payload: opml,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ categoriesCreated: 1, subscribed: 1 });

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/opml',
      headers: { cookie: headers.cookie ?? '', 'content-type': 'application/xml' },
      payload: opml,
    });
    expect(noCsrf.statusCode).toBe(403);

    const exported = await app.inject({ method: 'GET', url: '/api/v1/opml', headers });
    expect(exported.headers['content-type']).toMatch(/^text\/x-opml/);
    expect(exported.headers['content-disposition']).toContain('subscriptions.opml');
    expect(exported.body).toContain('xmlUrl="https://f.example/rss"');
  });
});
