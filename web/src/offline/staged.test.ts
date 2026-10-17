import 'fake-indexeddb/auto';
import type { Entry, StagedPage, SyncResponse } from '@newses/shared';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOfflineDb, type OfflineDb, toStoredEntry } from './db.ts';
import { importStaged } from './staged.ts';
import { storedSyncToken } from './sync.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

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

const syncPage = (since: string, next: string, entries: Entry[]): StagedPage => ({
  kind: 'sync',
  since,
  body: JSON.stringify({
    categories: [],
    subscriptions: [],
    labels: [],
    entries,
    deleted: { categories: [], subscriptions: [], labels: [], entries: [] },
    next,
    more: false,
  } satisfies SyncResponse),
});

const contentsPage = (ids: number[]): StagedPage => ({
  kind: 'contents',
  since: null,
  body: JSON.stringify({
    entries: ids.map((id) => ({
      id,
      contentVersion: 'v1',
      content: `<p>text ${String(id)}</p>`,
      fullContent: null,
      enclosures: [],
      images: [],
    })),
    missing: [],
    deferred: [],
  }),
});

let db: OfflineDb;

beforeEach(async () => {
  db = openOfflineDb('newses-staged');
  await db.meta.put({ key: 'syncToken', value: 'T1' });
});

afterEach(async () => {
  db.close();
  await Dexie.delete('newses-staged');
});

describe('importStaged', () => {
  it('stores pages in order from where the store stood, and carries the token on', async () => {
    const result = await importStaged(
      db,
      [syncPage('T1', 'T2', [entry(1)]), syncPage('T2', 'T3', [entry(2)]), contentsPage([1, 2, 9])],
      { now: NOW },
    );
    expect(result).toMatchObject({ token: 'T3', contents: 2 });
    expect(result.changes.map((c) => c.next)).toEqual(['T2', 'T3']);
    expect(await storedSyncToken(db)).toBe('T3');
    expect((await db.entries.toCollection().primaryKeys()).sort()).toEqual([1, 2]);
    expect((await db.contents.get(1))?.words).toContain('text');
  });

  it('leaves pages from a gap on, so older changes never overwrite newer ones', async () => {
    await db.entries.put(
      toStoredEntry(entry(1, { unread: false, readAt: new Date(NOW).toISOString() })),
    );
    const result = await importStaged(
      db,
      [
        // Fetched from an older token: the store has moved on since.
        syncPage('T0', 'T1', [entry(1)]),
        syncPage('T1', 'T2', [entry(2)]),
      ],
      { now: NOW },
    );
    expect(result.changes).toEqual([]);
    expect(await storedSyncToken(db)).toBe('T1');
    expect((await db.entries.get(1))?.unread).toBe(0);
  });

  it('skips a damaged page, and needs a store that has synced', async () => {
    const result = await importStaged(db, [{ kind: 'sync', since: 'T1', body: '{' }], { now: NOW });
    expect(result.token).toBe('T1');
    await db.meta.delete('syncToken');
    expect((await importStaged(db, [syncPage('T1', 'T2', [entry(1)])])).changes).toEqual([]);
  });
});
