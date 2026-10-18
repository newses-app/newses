import 'fake-indexeddb/auto';
import type { Entry, SyncResponse } from '@newses/shared';
import { createApiClient } from '@newses/shared/client';
import { QueryClient } from '@tanstack/vue-query';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOfflineDb, type OfflineDb } from './db.ts';
import { mirrorQueries, readQuery, seedQueries } from './snapshot.ts';
import { pruneStore, supportsOffline, syncStore } from './sync.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const entry = (id: number, overrides: Partial<Entry> = {}): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'F',
  title: `E${String(id)}`,
  link: null,
  author: null,
  publishedAt: null,
  sortAt: new Date(NOW - id * 60_000).toISOString(),
  unread: true,
  starred: false,
  published: false,
  score: 0,
  note: null,
  labels: [],
  tags: [],
  shareId: null,
  readAt: null,
  contentVersion: 'v1',
  excerpt: null,
  ...overrides,
});

const changes = (overrides: Partial<SyncResponse> = {}): SyncResponse => ({
  categories: [],
  subscriptions: [],
  labels: [],
  entries: [],
  deleted: { categories: [], subscriptions: [], labels: [], entries: [] },
  next: 'T2',
  more: false,
  ...overrides,
});

type Handler = (url: URL) => unknown;

/** A server answering `METHOD /path` routes with JSON; records what was asked, in order. */
function fakeServer(routes: Record<string, Handler>) {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    asked.push(`${route}${url.search}`);
    const handler = routes[route];
    if (!handler) return Promise.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
    const body = handler(url);
    return Promise.resolve(body instanceof Response ? body : Response.json(body));
  };
  const api = createApiClient({ baseUrl: 'https://reader.example', token: 't', fetch });
  return { api, asked };
}

const LISTS: Record<string, Handler> = {
  'GET /auth/session': () => ({ user: { id: 1 }, csrfToken: 'secret', iconsPath: '/i' }),
  'GET /prefs': () => ({ theme: 'dark' }),
  'GET /subscriptions': () => [
    { id: 1, title: 'One' },
    { id: 2, title: 'Two' },
  ],
  'GET /categories': () => [],
  'GET /labels': () => [],
  'GET /themes': () => [],
  'GET /counters': () => ({ subscriptions: [] }),
  'GET /tags': () => [],
};

let db: OfflineDb;

beforeEach(() => {
  db = openOfflineDb('newses-test');
});

afterEach(async () => {
  db.close();
  await Dexie.delete('newses-test');
});

describe('syncStore', () => {
  it('bootstraps from a token taken first, pages the lists, then follows changes', async () => {
    const { api, asked } = fakeServer({
      ...LISTS,
      'GET /sync/token': () => ({ next: 'T0' }),
      'GET /entries': (url) => {
        const special = url.searchParams.get('special');
        if (special === 'all')
          return url.searchParams.get('cursor')
            ? { entries: [entry(2)], cursor: null, view: 'unread' }
            : { entries: [entry(1)], cursor: 'c1', view: 'unread' };
        if (special === 'starred')
          return {
            entries: [entry(3, { unread: false, starred: true, readAt: daysAgo(40) })],
            cursor: null,
            view: 'all',
          };
        return {
          entries: [
            entry(4, { unread: false, readAt: daysAgo(1) }),
            entry(5, { unread: false, readAt: daysAgo(9) }),
          ],
          cursor: null,
          view: 'all',
        };
      },
      'GET /sync': () => changes({ entries: [entry(6)] }),
    });

    expect(await syncStore({ api, db, now: () => NOW })).toBe('bootstrap');
    expect(asked[0]).toBe('GET /sync/token');
    expect(asked.filter((a) => a.startsWith('GET /entries'))).toEqual([
      'GET /entries?special=all&view=unread&limit=200',
      'GET /entries?special=all&view=unread&limit=200&cursor=c1',
      'GET /entries?special=starred&view=all&limit=200',
      'GET /entries?special=recentlyRead&view=all&limit=200',
    ]);
    expect(asked.at(-1)).toBe('GET /sync?since=T0&limit=1000');
    // Read nine days ago: past the seven kept.
    expect((await db.entries.toCollection().primaryKeys()).sort()).toEqual([1, 2, 3, 4, 6]);
    expect(await readQuery(db, 'session')).toMatchObject({ user: { id: 1 }, csrfToken: null });
    expect((await db.meta.get('syncToken'))?.value).toBe('T2');
  });

  it('loads the unread of subscriptions hidden from All after All, within its cap', async () => {
    const { api, asked } = fakeServer({
      ...LISTS,
      'GET /subscriptions': () => [
        { id: 1, title: 'One', hideFromAll: false },
        { id: 2, title: 'Two', hideFromAll: true },
      ],
      'GET /sync/token': () => ({ next: 'T0' }),
      'GET /entries': (url) =>
        url.searchParams.get('subscriptionId') === '2'
          ? { entries: [entry(7, { subscriptionId: 2 })], cursor: null, view: 'unread' }
          : { entries: [], cursor: null, view: 'all' },
      'GET /sync': () => changes(),
    });

    await syncStore({ api, db, now: () => NOW });
    expect(asked.filter((a) => a.startsWith('GET /entries'))).toContain(
      'GET /entries?subscriptionId=2&view=unread&limit=200',
    );
    expect(await db.entries.toCollection().primaryKeys()).toEqual([7]);
  });

  it('applies changes: state, deletions, and lists, and reports them', async () => {
    await db.entries.bulkPut(
      [1, 2, 3].map((id) => ({
        ...entry(id),
        unread: 1 as const,
        starred: 0 as const,
        published: 0 as const,
      })),
    );
    await db.contents.put({
      id: 2,
      contentVersion: 'v1',
      content: 'x',
      fullContent: null,
      enclosures: [],
      images: [],
      bytes: 1,
    });
    await db.meta.bulkPut([
      { key: 'syncToken', value: 'T1' },
      {
        key: 'query:subscriptions',
        value: {
          data: [
            { id: 1, title: 'One' },
            { id: 2, title: 'Two' },
          ],
          at: 0,
        },
      },
    ]);
    const delta = changes({
      entries: [
        entry(1, { unread: false, starred: true }),
        entry(2, { unread: false, readAt: daysAgo(30) }),
      ],
      deleted: { categories: [], subscriptions: [2], labels: [], entries: [3] },
      subscriptions: [{ id: 1, title: 'Renamed' } as SyncResponse['subscriptions'][number]],
    });
    const pages = [{ ...delta, more: true, next: 'T2' }, changes({ next: 'T3' })];
    const { api, asked } = fakeServer({ 'GET /sync': () => pages.shift() });
    const onChanges = vi.fn();

    expect(await syncStore({ api, db, now: () => NOW, onChanges })).toBe('changes');
    expect(asked).toEqual(['GET /sync?since=T1&limit=1000', 'GET /sync?since=T2&limit=1000']);
    expect(await db.entries.toCollection().primaryKeys()).toEqual([1]);
    expect(await db.entries.get(1)).toMatchObject({ unread: 0, starred: 1 });
    // Content leaves with its entry.
    expect(await db.contents.get(2)).toBeUndefined();
    expect(await readQuery(db, 'subscriptions')).toEqual([{ id: 1, title: 'Renamed' }]);
    expect((await db.meta.get('syncToken'))?.value).toBe('T3');
    expect(onChanges).toHaveBeenCalledTimes(2);
  });

  it('loads everything again once the server forgot deletions, after sending queued changes', async () => {
    await db.entries.put({ ...entry(9), unread: 1, starred: 0, published: 0 });
    await db.meta.put({ key: 'syncToken', value: 'old' });
    const { api, asked } = fakeServer({
      ...LISTS,
      'GET /sync': (url) =>
        url.searchParams.get('since') === 'old'
          ? Response.json({ error: 'resync_required', message: 'Too old' }, { status: 410 })
          : changes(),
      'GET /sync/token': () => ({ next: 'T0' }),
      'GET /entries': () => ({ entries: [entry(1)], cursor: null, view: 'all' }),
    });
    const beforeResync = vi.fn(() => Promise.resolve());

    expect(await syncStore({ api, db, now: () => NOW, beforeResync })).toBe('bootstrap');
    expect(beforeResync).toHaveBeenCalledOnce();
    expect(asked.indexOf('GET /sync/token')).toBe(1);
    expect(await db.entries.toCollection().primaryKeys()).toEqual([1]);
  });

  it('keeps errors other than a forgotten token', async () => {
    await db.meta.put({ key: 'syncToken', value: 'T1' });
    const { api } = fakeServer({
      'GET /sync': () => Response.json({ error: 'internal', message: 'x' }, { status: 500 }),
    });
    await expect(syncStore({ api, db })).rejects.toMatchObject({ status: 500 });
    expect((await db.meta.get('syncToken'))?.value).toBe('T1');
  });
});

describe('pruneStore', () => {
  it('drops stale reads and the oldest past each limit', async () => {
    const stored = (e: Entry) => ({
      ...e,
      unread: e.unread ? (1 as const) : (0 as const),
      starred: e.starred ? (1 as const) : (0 as const),
      published: 0 as const,
    });
    await db.entries.bulkPut([
      // Unread; 1 is the newest.
      stored(entry(1)),
      stored(entry(2)),
      stored(entry(3)),
      // Unread and starred: counted as starred, not against the unread limit.
      stored(entry(4, { starred: true })),
      // Read 1 and 3 days ago, and 10 days ago.
      stored(entry(5, { unread: false, readAt: daysAgo(1) })),
      stored(entry(6, { unread: false, readAt: daysAgo(3) })),
      stored(entry(7, { unread: false, readAt: daysAgo(10) })),
    ]);
    const removed = await pruneStore(db, NOW, { unread: 2, starred: 5, readDays: 7, read: 1 });
    expect(removed).toBe(3);
    expect((await db.entries.toCollection().primaryKeys()).sort()).toEqual([1, 2, 4, 5]);
  });
});

describe('snapshot', () => {
  it('mirrors queries as they load, without the CSRF token, and seeds them back as stale', async () => {
    const queryClient = new QueryClient();
    const stop = mirrorQueries(queryClient, () => db);
    queryClient.setQueryData(['session'], { user: { id: 1 }, csrfToken: 'secret' });
    queryClient.setQueryData(['subscriptions'], [{ id: 1 }]);
    queryClient.setQueryData(['entries', 'all'], { pages: [] });
    await vi.waitFor(async () => {
      expect(await readQuery(db, 'subscriptions')).toEqual([{ id: 1 }]);
    });
    stop();
    expect(await readQuery(db, 'session')).toEqual({ user: { id: 1 }, csrfToken: null });
    expect(await db.meta.count()).toBe(2);

    const fresh = new QueryClient();
    expect(await seedQueries(fresh, db)).toBe(true);
    expect(fresh.getQueryData(['subscriptions'])).toEqual([{ id: 1 }]);
    expect(fresh.getQueryState(['subscriptions'])?.dataUpdatedAt).toBeLessThanOrEqual(Date.now());
    expect(await seedQueries(new QueryClient(), openOfflineDb('newses-empty'))).toBe(false);
    await Dexie.delete('newses-empty');
  });
});

describe('supportsOffline', () => {
  it('needs API 1.1 or a later minor', () => {
    const info = (major: number, minor: number) => ({
      product: 'newses',
      version: 'x',
      apiVersion: { major, minor },
    });
    expect(supportsOffline(info(1, 0))).toBe(false);
    expect(supportsOffline(info(1, 1))).toBe(true);
    expect(supportsOffline(info(1, 4))).toBe(true);
    expect(supportsOffline(info(2, 1))).toBe(false);
  });
});
