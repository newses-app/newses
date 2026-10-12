import type { ArchivedEntry, ArchiveEntriesResponse, Entry } from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { userEntries } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let headers: Record<string, string>;

const fetcher = new FakeFetcher().set('https://news.example/rss', {
  body: rss('News', 'https://news.example/', [
    {
      guid: '1',
      title: 'Old story',
      description: 'About kittens',
      pubDate: 'Sat, 03 Oct 2026 10:00:00 GMT',
    },
    {
      guid: '2',
      title: 'Older story',
      description: 'About puppies',
      pubDate: 'Fri, 02 Oct 2026 10:00:00 GMT',
    },
  ]),
});

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  const services = createTestServices(db, fetcher);
  await services.users.create('alice', 'alice password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password' },
  });
  headers = {
    cookie: `rss_session=${login.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
  };
  await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers,
    payload: { url: 'https://news.example/rss' },
  });
  // Purged for alice: the entries stay in the database without her holding them.
  await db.delete(userEntries);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('archive API', () => {
  it('lists, gets, and restores past articles', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/archive/entries?limit=1',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const page = list.json<ArchiveEntriesResponse>();
    expect(page.entries.map((e) => e.title)).toEqual(['Old story']);
    expect(page.cursor).not.toBeNull();
    const next = await app.inject({
      method: 'GET',
      url: `/api/v1/archive/entries?limit=1&cursor=${page.cursor ?? ''}`,
      headers,
    });
    expect(next.json<ArchiveEntriesResponse>().entries.map((e) => e.title)).toEqual([
      'Older story',
    ]);

    const key = encodeURIComponent(page.entries[0]?.key ?? '');
    const one = await app.inject({ method: 'GET', url: `/api/v1/archive/entries/${key}`, headers });
    expect(one.json<ArchivedEntry>()).toMatchObject({
      archived: true,
      title: 'Old story',
      content: expect.stringContaining('kittens') as string,
    });

    const restore = await app.inject({
      method: 'POST',
      url: `/api/v1/archive/entries/${key}/restore`,
      headers,
      payload: { starred: true },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json<Entry>()).toMatchObject({
      title: 'Old story',
      starred: true,
      unread: false,
    });
    const after = await app.inject({ method: 'GET', url: '/api/v1/archive/entries', headers });
    expect(after.json<ArchiveEntriesResponse>().entries.map((e) => e.title)).toEqual([
      'Older story',
    ]);
  });

  it('refuses strangers, unknown keys, and bad cursors', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/archive/entries' })).statusCode).toBe(
      401,
    );
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/archive/entries/2024-01.bm9uZQ',
      headers,
    });
    expect(missing.statusCode).toBe(404);
    const cursor = await app.inject({
      method: 'GET',
      url: '/api/v1/archive/entries?cursor=nonsense',
      headers,
    });
    expect(cursor.statusCode).toBe(400);
    const restore = await app.inject({
      method: 'POST',
      url: '/api/v1/archive/entries/2024-01.bm9uZQ/restore',
      headers,
      payload: {},
    });
    expect(restore.statusCode).toBe(400);
  });
});
