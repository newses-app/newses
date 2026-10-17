import 'fake-indexeddb/auto';
import type { Entry } from '@newses/shared';
import { createApiClient } from '@newses/shared/client';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromStoredEntry, openOfflineDb, type OfflineDb, toStoredEntry } from './db.ts';
import { localCatchUp, newestStoredId } from './local.ts';
import { flushOutbox, outboxPending, queueChanges, withPending } from './outbox.ts';
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
    expect(await flushOutbox(api, db)).toEqual({ sent: 5, refused: [], stopped: null });
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
    expect(await flushOutbox(api, db)).toEqual({ sent: 0, refused: [], stopped });
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
    expect(await flushOutbox(api, db)).toEqual({
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
