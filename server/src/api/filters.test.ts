import type { Filter, FilterRequest } from '@rss-reader/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let headers: Record<string, string>;
let alice = 0;
let rustLabel = 0;
let bobLabel = 0;

const fetcher = new FakeFetcher().set('https://a.example/rss', {
  body: rss('A', 'https://a.example/', [
    { guid: '1', title: 'Rust release', description: 'A faster compiler' },
    { guid: '2', title: 'Python news', description: 'Typing' },
    { guid: '3', title: 'Sponsored: buy now', description: 'Rust shoes' },
  ]),
});

interface Reply<T> {
  status: number;
  body: T;
}

const call = async <T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
): Promise<Reply<T>> => {
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(payload && { payload }),
  });
  return { status: response.statusCode, body: (response.body ? response.json() : null) as T };
};

const titleRule = (pattern: string) => ({ field: 'title' as const, pattern });

/** Alice's entries by title, with their state. */
async function entries() {
  const { body } = await call<{
    entries: {
      id: number;
      title: string;
      unread: boolean;
      starred: boolean;
      published: boolean;
      score: number;
      labels: number[];
      tags: string[];
    }[];
  }>('GET', '/entries?limit=100');
  return new Map(body.entries.map((e) => [e.title, e]));
}

beforeAll(async () => {
  database = await createTestDatabase();
  services = createTestServices(createDb(database.pool), fetcher);
  alice = (await services.users.create('alice', 'alice password')).id;
  const bob = (await services.users.create('bob', 'bob password')).id;
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
  const colours = { fgColor: '#ffffff', bgColor: '#000000' };
  rustLabel = (await services.entries.labels.create(alice, { caption: 'Rust', ...colours })).id;
  bobLabel = (await services.entries.labels.create(bob, { caption: 'Bob', ...colours })).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('filters API', () => {
  it('validates filters: RE2 patterns, own labels, at least one rule and action', async () => {
    const bad = await call<{ message: string }>('POST', '/filters', {
      title: 'Lookbehind',
      rules: [titleRule('(?<=a)b')],
      actions: [{ type: 'star' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Invalid pattern/);
    const foreign = await call('POST', '/filters', {
      title: 'Foreign label',
      rules: [titleRule('x')],
      actions: [{ type: 'label', labelId: bobLabel }],
    });
    expect(foreign.status).toBe(404);
    const empty = await call('POST', '/filters', { title: 'Empty', rules: [], actions: [] });
    expect(empty.status).toBe(400);
  });

  it('runs filters in order on newly delivered entries', async () => {
    const created: Filter[] = [];
    for (const filter of [
      {
        title: 'Ads',
        rules: [titleRule('^sponsored')],
        actions: [{ type: 'delete' }, { type: 'stop' }],
      },
      {
        title: 'Rust',
        rules: [{ field: 'titleOrContent', pattern: 'rust' }],
        actions: [
          { type: 'label', labelId: rustLabel },
          { type: 'tag', tag: 'Lang' },
          { type: 'score', score: 5 },
          { type: 'star' },
        ],
      },
      { title: 'Python', rules: [titleRule('python')], actions: [{ type: 'markRead' }] },
    ] satisfies FilterRequest[]) {
      const response = await call<Filter>('POST', '/filters', filter);
      expect(response.status).toBe(201);
      created.push(response.body);
    }
    expect(created.map((f) => f.sortOrder)).toEqual([0, 1, 2]);

    await call('POST', '/subscriptions', { url: 'https://a.example/rss' });
    const list = await entries();
    expect([...list.keys()].sort()).toEqual(['Python news', 'Rust release']);
    expect(list.get('Rust release')).toMatchObject({
      starred: true,
      score: 5,
      labels: [rustLabel],
      tags: ['lang'],
      unread: true,
    });
    expect(list.get('Python news')).toMatchObject({ unread: false, starred: false });
  });

  it('tests a draft filter against recent entries', async () => {
    const response = await call<{ checked: number; matched: number; matches: { title: string }[] }>(
      'POST',
      '/filters/test',
      { title: 'Draft', rules: [titleRule('python|rust')], actions: [{ type: 'star' }] },
    );
    expect(response.body).toMatchObject({ checked: 2, matched: 2 });
    expect(response.body.matches.map((e) => e.title).sort()).toEqual([
      'Python news',
      'Rust release',
    ]);
  });

  it('applies a saved filter to existing entries, sparing kept ones from deletion', async () => {
    const publish = await call<Filter>('POST', '/filters', {
      title: 'Publish Python',
      enabled: false,
      rules: [titleRule('python')],
      actions: [{ type: 'publish' }],
    });
    const applied = await call('POST', `/filters/${String(publish.body.id)}/apply`, {});
    expect(applied.body).toEqual({ checked: 2, matched: 1, cursor: null });
    expect((await entries()).get('Python news')?.published).toBe(true);

    const purge = await call<Filter>('POST', '/filters', {
      title: 'Delete all',
      rules: [titleRule('.')],
      actions: [{ type: 'delete' }],
    });
    await call('POST', `/filters/${String(purge.body.id)}/apply`, {});
    // Both are kept: one starred, one published.
    expect([...(await entries()).keys()].sort()).toEqual(['Python news', 'Rust release']);
    await call('DELETE', `/filters/${String(purge.body.id)}`);
  });

  it('lists, reorders, updates, and deletes filters', async () => {
    const before = (await call<Filter[]>('GET', '/filters')).body;
    const reversed = before.map((f) => f.id).reverse();
    const reordered = await call<Filter[]>('PUT', '/filters/order', { filterIds: reversed });
    expect(reordered.body.map((f) => f.id)).toEqual(reversed);

    const [first] = reordered.body;
    const updated = await call<Filter>('PUT', `/filters/${String(first?.id)}`, {
      title: 'Renamed',
      matchAny: true,
      rules: [titleRule('a'), { field: 'tag', pattern: 'b', inverse: true, categoryIds: [1] }],
      actions: [{ type: 'score', score: -3 }],
    });
    expect(updated.body).toMatchObject({
      title: 'Renamed',
      matchAny: true,
      enabled: true,
      rules: [
        { field: 'title', pattern: 'a', inverse: false, subscriptionIds: [], categoryIds: [] },
        { field: 'tag', pattern: 'b', inverse: true, subscriptionIds: [], categoryIds: [1] },
      ],
      actions: [{ type: 'score', score: -3 }],
    });
    expect((await call('DELETE', `/filters/${String(first?.id)}`)).status).toBe(204);
    expect((await call('DELETE', `/filters/${String(first?.id)}`)).status).toBe(404);
  });
});
