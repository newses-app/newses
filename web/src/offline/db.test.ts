import 'fake-indexeddb/auto';
import type { Entry } from '@newses/shared';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountSignedIn,
  accountSignedOut,
  databaseName,
  lastAccount,
  markFilled,
  wasEvicted,
} from './account.ts';
import { exclusively, fromStoredEntry, openOfflineDb, toStoredEntry } from './db.ts';

const entry = (id: number, overrides: Partial<Entry> = {}): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'F',
  title: `E${String(id)}`,
  link: null,
  author: null,
  publishedAt: null,
  sortAt: `2026-10-0${String(id)}T00:00:00.000Z`,
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

const exists = async (name: string) => (await Dexie.getDatabaseNames()).includes(name);

afterEach(async () => {
  localStorage.clear();
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
});

describe('offline store', () => {
  it('stores headlines without content, flags indexed as numbers', async () => {
    const db = openOfflineDb('newses-1');
    await db.entries.bulkPut([
      toStoredEntry(entry(1, { content: '<p>x</p>', labels: [3] })),
      toStoredEntry(entry(2, { unread: false, starred: true, tags: ['cats'] })),
      toStoredEntry(entry(3)),
    ]);
    const unread = await db.entries
      .where('[unread+sortAt]')
      .between([1, Dexie.minKey], [1, Dexie.maxKey])
      .reverse()
      .primaryKeys();
    expect(unread).toEqual([3, 1]);
    expect(await db.entries.where('labels').equals(3).primaryKeys()).toEqual([1]);
    expect(await db.entries.where('tags').equals('cats').primaryKeys()).toEqual([2]);
    const stored = await db.entries.get(1);
    expect(stored).not.toHaveProperty('content');
    expect(stored && fromStoredEntry(stored)).toEqual(entry(1, { labels: [3] }));
    db.close();
  });

  it('closes for a newer schema in another tab and says so', async () => {
    const replaced = vi.fn();
    const db = openOfflineDb('newses-2', replaced);
    await db.open();
    const newer = new Dexie('newses-2');
    newer.version(2).stores({ entries: 'id' });
    await newer.open();
    expect(replaced).toHaveBeenCalledOnce();
    expect(db.isOpen()).toBe(false);
    newer.close();
  });

  it('runs a task in one tab at a time, and in every tab without Web Locks', async () => {
    const task = vi.fn(() => Promise.resolve());
    expect(await exclusively('sync', task)).toBe(true);
    const held = {
      request: (_name: string, _options: object, run: (lock: null) => unknown) => run(null),
    };
    Object.defineProperty(navigator, 'locks', { value: held, configurable: true });
    try {
      expect(await exclusively('sync', task)).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
    expect(task).toHaveBeenCalledOnce();
  });
});

describe('accounts', () => {
  it('names stores per user, and in the apps per server', async () => {
    expect(await databaseName({ userId: 7, serverUrl: null })).toBe('newses-7');
    const a = await databaseName({ userId: 7, serverUrl: 'https://a.example' });
    const b = await databaseName({ userId: 7, serverUrl: 'https://b.example' });
    expect(a).toMatch(/^newses-[0-9a-f]{12}-7$/);
    expect(b).not.toBe(a);
  });

  it('keeps the store for the same account and deletes it for another or on sign-out', async () => {
    await accountSignedIn({ userId: 1, serverUrl: null });
    const db = openOfflineDb('newses-1');
    await db.meta.put({ key: 'syncToken', value: 't' });
    db.close();

    await accountSignedIn({ userId: 1, serverUrl: null });
    expect(await exists('newses-1')).toBe(true);
    await accountSignedIn({ userId: 2, serverUrl: null });
    expect(await exists('newses-1')).toBe(false);
    expect(lastAccount()).toMatchObject({ userId: 2, name: 'newses-2' });

    await openOfflineDb('newses-2').open();
    await accountSignedOut();
    expect(await exists('newses-2')).toBe(false);
    expect(lastAccount()).toBeNull();
  });

  it('tells a store the browser cleared from one never filled', async () => {
    await accountSignedIn({ userId: 3, serverUrl: null });
    const db = openOfflineDb('newses-3');
    expect(await wasEvicted(db)).toBe(false);
    markFilled();
    expect(await wasEvicted(db)).toBe(true);
    await db.meta.put({ key: 'syncToken', value: 't' });
    expect(await wasEvicted(db)).toBe(false);
    db.close();
  });
});
