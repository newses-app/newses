import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_OPML_OUTLINES } from '@newses/shared';
import { RATE_LIMITS } from '../core/rate-limit.ts';
import { createDb, type Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let headers: Record<string, string>;
const fetcher = new FakeFetcher();

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher);
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await services.users.create('alice', 'alice password');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password' },
  });
  headers = {
    cookie: `rss_session=${res.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
    'x-csrf-token': res.json<{ csrfToken: string }>().csrfToken,
  };
});

beforeEach(async () => {
  await db.delete(rateLimits);
  fetcher.requested.length = 0;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('per-user rate limits', () => {
  it('rate limit subscribing to new feeds, with Retry-After', async () => {
    const subscribe = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions',
        headers,
        payload: { url: `https://missing.example/${String(n)}` },
      });
    for (let n = 0; n < RATE_LIMITS.subscribe; n++)
      expect((await subscribe(n)).statusCode).not.toBe(429);
    const refused = await subscribe(99);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(fetcher.requested).toHaveLength(RATE_LIMITS.subscribe);
  });

  it('publish pages unread past the limit', async () => {
    const publish = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/published-feed/pages',
        headers,
        payload: { url: `https://pages.example/${String(n)}` },
      });
    for (let n = 0; n <= RATE_LIMITS.page; n++) expect((await publish(n)).statusCode).toBe(200);
    expect(fetcher.requested).toHaveLength(RATE_LIMITS.page);
  });

  it('refuse OPML files over the limit, and rate limit imports', async () => {
    const importOpml = (outlines: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/opml',
        headers: { ...headers, 'content-type': 'text/x-opml' },
        payload: `<?xml version="1.0"?><opml version="2.0"><head/><body>${Array.from(
          { length: outlines },
          (_, n) => `<outline text="x" xmlUrl="https://many.example/${String(n)}"/>`,
        ).join('')}</body></opml>`,
      });
    const over = await importOpml(MAX_OPML_OUTLINES + 1);
    expect(over.statusCode).toBe(400);
    expect(over.json<{ error: string }>().error).toBe('invalid_input');
    for (let n = 1; n < RATE_LIMITS.import; n++) expect((await importOpml(1)).statusCode).toBe(200);
    expect((await importOpml(1)).statusCode).toBe(429);
  });
});
