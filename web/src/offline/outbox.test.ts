import 'fake-indexeddb/auto';
import type { Entry } from '@newses/shared';
import { createApiClient } from '@newses/shared/client';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromStoredEntry, openOfflineDb, type OfflineDb, toStoredEntry } from './db.ts';
import { localCatchUp, newestStoredId } from './local.ts';
import { flushOutbox, queueChanges, withPending } from './outbox.ts';
import { outboxPending } from './status.ts';
import { writeQuery } from './snapshot.ts';
import { storeEntries } from './sync.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

const entry = (id: number, overrides: Partial<Entry> = {}): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'F',
  title: `E${String(id)}`,
  link: null,
  author: null,
  publishedAt: null,
  sortAt: new Date(NOW - id * 86_400_000).toISOString(),
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

let db: OfflineDb;

beforeEach(() => {
  db = openOfflineDb('newses-outbox');
});

afterEach(async () => {
  db.close();
  await Dexie.delete('newses-outbox');
});

type Answer = (body: unknown) => Response;

/** A server answering `METHOD /path` with `answer`, 204 otherwise; records requests in order. */
function server(answers: Record<string, Answer | undefined> = {}) {
  const asked: { route: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    asked.push({ route, body });
    const answer = answers[route];
    return Promise.resolve(answer ? answer(body) : new Response(null, { status: 204 }));
  };
  return { api: createApiClient({ baseUrl: 'https://r.example', token: 't', fetch }), asked };
}

const failing = (status: number, message = 'No', headers: Record<string, string> = {}) =>
  (() => Response.json({ error: 'x', message }, { status, headers })) satisfies Answer;

describe('queueChanges', () => {
  it('merges changes per entry and flag, keeping a catch-up in its place', async () => {
    await queueChanges(db, [
      { kind: 'state', id: 1, state: { unread: false } },
      { kind: 'state', id: 1, state: { starred: true } },
      { kind: 'note', id: 1, note: 'a' },
      { kind: 'note', id: 1, note: 'b' },
      { kind: 'markRead', request: { special: 'all', maxId: 9 } },
      { kind: 'state', id: 1, state: { unread: true } },
    ]);
    const rows = await db.outbox.orderBy('seq').toArray();
    expect(rows.map((r) => [r.kind, r.payload])).toEqual([
      ['state', { id: 1, state: { unread: false, starred: true } }],
      ['note', { id: 1, note: 'b' }],
      ['markRead', { request: { special: 'all', maxId: 9 } }],
      ['state', { id: 1, state: { unread: true } }],
    ]);
    expect(outboxPending.value).toBe(4);
  });

  it('keeps waiting changes over what the server sends until they are sent', async () => {
    await queueChanges(db, [{ kind: 'state', id: 1, state: { unread: false } }], NOW);
    await queueChanges(db, [{ kind: 'labels', id: 2, labelIds: [3, 1] }], NOW);
    const [one, two] = await withPending(db, [entry(1), entry(2)]);
    expect(one).toMatchObject({ unread: false, readAt: new Date(NOW).toISOString() });
    expect(two?.labels).toEqual([1, 3]);
    await storeEntries(db, [entry(1)], NOW);
    expect((await db.entries.get(1))?.unread).toBe(0);
  });
});

describe('flushOutbox', () => {
  it('sends oldest first, equal state changes in one bulk request', async () => {
    await queueChanges(db, [
      { kind: 'state', id: 1, state: { unread: false } },
      { kind: 'state', id: 2, state: { unread: false } },
      { kind: 'state', id: 3, state: { starred: true } },
      { kind: 'markRead', request: { subscriptionId: 4, maxId: 9 } },
      { kind: 'tags', id: 5, tags: ['x'] },
    ]);
    const { api, asked } = server({
      'PATCH /entries': () => Response.json({ updated: 2 }),
      'PATCH /entries/3': () => Response.json(entry(3)),
      'POST /entries/mark-read': () => Response.json({ updated: 1 }),
      'PUT /entries/5/tags': () => Response.json({ tags: ['x'] }),
    });
    expect(await flushOutbox(api, db)).toMatchObject({ sent: 5, refused: [], stopped: null });
    expect(asked).toEqual([
      { route: 'PATCH /entries', body: { ids: [1, 2], unread: false } },
      { route: 'PATCH /entries/3', body: { starred: true } },
      { route: 'POST /entries/mark-read', body: { subscriptionId: 4, maxId: 9 } },
      { route: 'PUT /entries/5/tags', body: { tags: ['x'] } },
    ]);
    expect(await db.outbox.count()).toBe(0);
  });

  it.each([
    ['the server cannot be reached', failing(503), 'unreachable'],
    ['the session ended', failing(401), 'unauthenticated'],
    [
      'the server asks to wait',
      failing(429, 'Slow', { 'retry-after': '7' }),
      { retryAfterSeconds: 7 },
    ],
  ] as const)('keeps changes when %s', async (_, answer, stopped) => {
    await queueChanges(db, [{ kind: 'note', id: 1, note: 'n' }]);
    const { api } = server({ 'PUT /entries/1/note': answer });
    expect(await flushOutbox(api, db)).toMatchObject({ sent: 0, refused: [], stopped });
    expect(await db.outbox.count()).toBe(1);
  });

  it('keeps changes when the network fails', async () => {
    await queueChanges(db, [{ kind: 'note', id: 1, note: 'n' }]);
    const api = createApiClient({
      baseUrl: 'https://r.example',
      token: 't',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect((await flushOutbox(api, db)).stopped).toBe('unreachable');
    expect(await db.outbox.count()).toBe(1);
  });

  it('drops changes to entries that are gone, and reports the ones the server refuses', async () => {
    await queueChanges(db, [
      { kind: 'note', id: 1, note: 'n' },
      { kind: 'state', id: 2, state: { score: 5 } },
      { kind: 'tags', id: 3, tags: ['t'] },
    ]);
    const { api } = server({
      'PUT /entries/1/note': failing(404),
      'PATCH /entries/2': failing(422, 'Bad score'),
      'PUT /entries/3/tags': () => Response.json({ tags: ['t'] }),
    });
    expect(await flushOutbox(api, db)).toMatchObject({
      sent: 1,
      refused: [{ op: { kind: 'state', id: 2, state: { score: 5 } }, message: 'Bad score' }],
      stopped: null,
    });
    expect(await db.outbox.count()).toBe(0);
  });

  it('sends labels again without the ones that no longer exist', async () => {
    await queueChanges(db, [{ kind: 'labels', id: 1, labelIds: [1, 2] }]);
    const { api, asked } = server({
      'PUT /entries/1/labels': (body) =>
        (body as { labelIds: number[] }).labelIds.includes(2)
          ? failing(404)()
          : new Response(null, { status: 204 }),
      'GET /labels': () => Response.json([{ id: 1, name: 'a', color: null }]),
    });
    expect(await flushOutbox(api, db)).toMatchObject({ sent: 1, stopped: null });
    expect(asked.map((a) => a.route)).toEqual([
      'PUT /entries/1/labels',
      'GET /labels',
      'PUT /entries/1/labels',
    ]);
    expect(asked[2]?.body).toEqual({ labelIds: [1] });
  });
});

describe('flushOutbox against a server that detects conflicts', () => {
  it('keeps what the entry had first when merging changes', async () => {
    await queueChanges(db, [
      { kind: 'state', id: 1, state: { starred: true }, expect: { starred: false } },
      {
        kind: 'state',
        id: 1,
        state: { starred: false, unread: false },
        expect: { starred: true, unread: true },
      },
      { kind: 'note', id: 1, note: 'a', expected: null },
      { kind: 'note', id: 1, note: 'b', expected: 'a' },
      { kind: 'labels', id: 1, labelIds: [1], base: [] },
      { kind: 'labels', id: 1, labelIds: [1, 2], base: [1] },
    ]);
    const rows = await db.outbox.orderBy('seq').toArray();
    expect(rows.map((r) => r.payload)).toEqual([
      { id: 1, state: { starred: false, unread: false }, expect: { starred: false, unread: true } },
      { id: 1, note: 'b', expected: null },
      { id: 1, labelIds: [1, 2], base: [] },
    ]);
  });

  it('sends changes against what the entry had, and reports the ones changed elsewhere', async () => {
    await queueChanges(db, [
      { kind: 'state', id: 1, state: { starred: true }, expect: { starred: false } },
      { kind: 'state', id: 2, state: { starred: true }, expect: { starred: false } },
      { kind: 'labels', id: 1, labelIds: [2, 3], base: [1, 2] },
      { kind: 'tags', id: 1, tags: ['B', 'c'], base: ['a', 'b'] },
      { kind: 'note', id: 1, note: ' mine ', expected: null },
      { kind: 'labels', id: 2, labelIds: [4] },
    ]);
    const { api, asked } = server({
      'PATCH /entries': () =>
        Response.json({
          updated: 1,
          conflicts: [
            { id: 2, current: { unread: true, starred: false, published: false, score: 0 } },
          ],
        }),
      'PATCH /entries/1/labels': () => Response.json({ labelIds: [2, 3] }),
      'PATCH /entries/1/tags': () => Response.json({ tags: ['b', 'c'] }),
      'PUT /entries/1/note': () =>
        Response.json({ error: 'conflict', message: 'Changed' }, { status: 409 }),
      'GET /entries/1': () => Response.json(entry(1, { note: 'theirs' })),
    });
    expect(await flushOutbox(api, db, { conflicts: true })).toMatchObject({
      sent: 6,
      overridden: 1,
      noteConflicts: [{ id: 1, mine: 'mine', theirs: 'theirs' }],
      stopped: null,
    });
    expect(asked.map((a) => [a.route, a.body])).toEqual([
      ['PATCH /entries', { ids: [1, 2], starred: true, expect: { starred: false } }],
      ['PATCH /entries/1/labels', { add: [3], remove: [1] }],
      ['PATCH /entries/1/tags', { add: ['c'], remove: ['a'] }],
      ['PUT /entries/1/note', { note: ' mine ', expected: null }],
      ['GET /entries/1', undefined],
      // Queued before changes recorded what the entry had: replaced as before.
      ['PUT /entries/2/labels', { labelIds: [4] }],
    ]);
  });
});

describe('changes to feeds, labels, preferences, and themes', () => {
  const colours = { fgColor: '#000000', bgColor: '#ffffff' };

  it('sends changes after what they name, with the ids the server gave', async () => {
    await queueChanges(db, [
      { kind: 'prefs', changes: { theme: 'dark' } },
      { kind: 'category.create', id: -1, body: { title: 'New', parentId: null } },
      { kind: 'subscription.update', id: 5, changes: { categoryId: -1 } },
      { kind: 'label.create', id: -2, body: { caption: 'Later', ...colours } },
      { kind: 'labels', id: 9, labelIds: [-2] },
      // Not merged into the first: it would then go before the theme it names.
      { kind: 'theme.create', id: -3, body: { name: 'Mine', base: 'original', tokens: {} } },
      { kind: 'prefs', changes: { appearanceTheme: -3 } },
    ]);
    const { api, asked } = server({
      'PATCH /prefs': () => Response.json({}),
      'POST /categories': () =>
        Response.json({ id: 40, title: 'New', parentId: null, sortOrder: 0, collapsed: false }),
      'PATCH /subscriptions/5': () => Response.json({}),
      'POST /labels': () => Response.json({ id: 50, caption: 'Later', ...colours }),
      'POST /themes': () => Response.json({ id: 60 }),
    });
    const result = await flushOutbox(api, db);
    expect(result).toMatchObject({ sent: 7, refused: [], stopped: null });
    expect(result.created.map((c) => [c.resource, c.tempId, c.value.id])).toEqual([
      ['category', -1, 40],
      ['label', -2, 50],
      ['theme', -3, 60],
    ]);
    expect(asked.map((a) => [a.route, a.body])).toEqual([
      ['PATCH /prefs', { theme: 'dark' }],
      ['POST /categories', { title: 'New', parentId: null }],
      ['PATCH /subscriptions/5', { categoryId: 40 }],
      ['POST /labels', { caption: 'Later', ...colours }],
      ['PUT /entries/9/labels', { labelIds: [50] }],
      ['POST /themes', { name: 'Mine', base: 'original', tokens: {} }],
      ['PATCH /prefs', { appearanceTheme: 60 }],
    ]);
  });

  it('forgets what was created offline and deleted before it was sent', async () => {
    await queueChanges(db, [
      { kind: 'category.create', id: -1, body: { title: 'Brief', parentId: 3 } },
      { kind: 'subscription.update', id: 5, changes: { categoryId: -1 } },
      { kind: 'category.update', id: -1, changes: { title: 'Briefly' } },
      { kind: 'label.create', id: -2, body: { caption: 'Gone', ...colours } },
      { kind: 'labels', id: 9, labelIds: [1, -2] },
    ]);
    await queueChanges(db, [
      { kind: 'category.delete', id: -1, parentId: 3 },
      { kind: 'label.delete', id: -2 },
    ]);
    const rows = await db.outbox.orderBy('seq').toArray();
    expect(rows.map((r) => [r.kind, r.payload])).toEqual([
      ['subscription.update', { id: 5, changes: { categoryId: 3 } }],
      ['labels', { id: 9, labelIds: [1] }],
    ]);
  });

  it('drops what depends on a refused subscription, and says why', async () => {
    await queueChanges(db, [
      { kind: 'subscription.create', id: -1, body: { url: 'https://a.example/' } },
      { kind: 'subscription.update', id: -1, changes: { title: 'A' } },
      { kind: 'prefs', changes: { theme: 'dark' } },
    ]);
    const { api, asked } = server({
      'POST /subscriptions': () => Response.json({ status: 'choose', candidates: [] }),
      'PATCH /prefs': () => Response.json({}),
    });
    const result = await flushOutbox(api, db);
    expect(result).toMatchObject({
      refused: [{ op: { kind: 'subscription.create' }, code: 'choose' }],
      dropped: [{ resource: 'subscription', tempId: -1 }],
    });
    expect(asked.map((a) => a.route)).toEqual(['POST /subscriptions', 'PATCH /prefs']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('numbers a theme name taken meanwhile, and keeps a refused theme as a draft', async () => {
    await queueChanges(db, [
      { kind: 'theme.create', id: -1, body: { name: 'Mine', base: 'original', tokens: {} } },
      { kind: 'theme.create', id: -2, body: { name: 'Fifty-first', base: 'original', tokens: {} } },
      { kind: 'prefs', changes: { appearanceTheme: -2 } },
    ]);
    const { api, asked } = server({
      'POST /themes': (body) => {
        const { name } = body as { name: string };
        if (name === 'Mine')
          return Response.json({ error: 'conflict', message: 'Taken' }, { status: 409 });
        if (name === 'Fifty-first')
          return Response.json(
            { error: 'invalid_input', message: 'At most 50 themes' },
            { status: 400 },
          );
        return Response.json({ id: 70 });
      },
      'GET /themes': () => Response.json([{ id: 1, name: 'Mine', mine: true }]),
      'PATCH /prefs': () => Response.json({}),
    });
    const result = await flushOutbox(api, db);
    expect(asked.map((a) => [a.route, a.body])).toEqual([
      ['POST /themes', { name: 'Mine', base: 'original', tokens: {} }],
      ['GET /themes', undefined],
      ['POST /themes', { name: 'Mine 2', base: 'original', tokens: {} }],
      ['POST /themes', { name: 'Fifty-first', base: 'original', tokens: {} }],
      ['PATCH /prefs', { appearanceTheme: 'original' }],
    ]);
    expect(result.themeDrafts).toEqual([{ name: 'Fifty-first', base: 'original', tokens: {} }]);
  });

  it('takes a label created offline that exists already for that label', async () => {
    await queueChanges(db, [
      { kind: 'label.create', id: -1, body: { caption: 'Later', ...colours } },
      { kind: 'labels', id: 9, labelIds: [-1] },
    ]);
    const { api, asked } = server({
      'POST /labels': () =>
        Response.json({ error: 'conflict', message: 'Exists' }, { status: 409 }),
      'GET /labels': () => Response.json([{ id: 12, caption: 'later', ...colours }]),
    });
    expect((await flushOutbox(api, db)).created).toMatchObject([{ tempId: -1, value: { id: 12 } }]);
    expect(asked.at(-1)).toEqual({ route: 'PUT /entries/9/labels', body: { labelIds: [12] } });
  });
});

describe('localCatchUp', () => {
  it("marks the stream's unread entries read, older than asked and up to the id", async () => {
    await writeQuery(db, 'subscriptions', [
      { id: 1, categoryId: null },
      { id: 2, categoryId: null },
    ]);
    await db.entries.bulkPut(
      [entry(1), entry(2), entry(3), entry(4, { subscriptionId: 2 }), entry(5)].map(toStoredEntry),
    );
    expect(await newestStoredId(db)).toBe(5);
    const caught = await localCatchUp(db, { subscriptionId: 1, olderThanDays: 1, maxId: 3 }, NOW);
    expect(caught.map((e) => e.id).sort()).toEqual([2, 3]);
    const stored = (await db.entries.toArray()).map(fromStoredEntry);
    expect(stored.filter((e) => !e.unread).map((e) => e.id)).toEqual([2, 3]);
    expect(stored.find((e) => e.id === 2)?.readAt).toBe(new Date(NOW).toISOString());
  });
});
