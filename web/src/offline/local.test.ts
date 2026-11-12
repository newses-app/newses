import 'fake-indexeddb/auto';
import type { Entry } from '@newses/shared';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOfflineDb, type OfflineDb, toStoredEntry } from './db.ts';
import { indexBytes, indexStoredContents } from './downloads.ts';
import { localList, searchStore } from './local.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

const entry = (id: number, title: string, overrides: Partial<Entry> = {}): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'Daily',
  title,
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

const content = (id: number, html: string) => ({
  id,
  contentVersion: 'v1',
  content: html,
  fullContent: null,
  enclosures: [],
  images: [],
  bytes: html.length,
});

let db: OfflineDb;
const NAME = 'newses-search';

beforeEach(() => {
  db = openOfflineDb(NAME);
});

afterEach(async () => {
  db.close();
  await Dexie.delete(NAME);
});

async function fill() {
  await db.entries.bulkPut(
    [
      entry(1, 'Rust compilers explained'),
      entry(2, 'Gardening notes', { author: 'Rusty Nail' }),
      entry(3, 'Weekly digest'),
      entry(4, 'Café culture'),
    ].map(toStoredEntry),
  );
  await db.contents.bulkPut([
    content(3, '<p>A new <b>Rust</b> compiler release</p>'),
    content(1, '<p>Nothing else</p>'),
  ]);
  await indexStoredContents(db);
}

describe('searchStore', () => {
  it('finds entries with every word in the headline or the content, the last as a prefix', async () => {
    await fill();
    expect([...((await searchStore(db, 'rust comp')) ?? [])].sort()).toEqual([1, 3]);
    expect([...((await searchStore(db, 'rust')) ?? [])].sort()).toEqual([1, 2, 3]);
    expect([...((await searchStore(db, 'rust compiler release')) ?? [])]).toEqual([3]);
    expect([...((await searchStore(db, 'cafe')) ?? [])]).toEqual([4]);
    expect([...((await searchStore(db, 'daily garden')) ?? [])]).toEqual([2]);
    expect(await searchStore(db, '  ')).toBeNull();
  });

  it('lists matches newest first, page by page, with content', async () => {
    await fill();
    const query = {
      stream: {},
      view: 'all' as const,
      order: 'newest' as const,
      limit: 2,
      content: true,
      q: 'rust',
    };
    const first = await localList(db, query);
    expect(first.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(first.entries[0]?.content).toBe('<p>Nothing else</p>');
    const second = await localList(db, { ...query, cursor: first.cursor ?? '' });
    expect(second.entries.map((e) => e.id)).toEqual([3]);
    expect(second.cursor).toBeNull();
  });
});

describe('search operators on the device', () => {
  it('drops entries with a negated word or phrase, and reads OR', async () => {
    await fill();
    const ids = async (q: string) => [...((await searchStore(db, q)) ?? [])].sort();
    // The last word typed is the one read as a prefix, here a negated one.
    expect(await ids('rust -digest')).toEqual([1]);
    expect(await ids('-rust')).toEqual([2, 4]);
    expect(await ids('rust -"compiler release"')).toEqual([1]);
    expect(await ids('-digest rust')).toEqual([1, 2]);
    expect(await ids('cafe OR gardening')).toEqual([2, 4]);
    expect(await ids('cafe OR gardening daily')).toEqual([2, 4]);
    expect(await ids('cafe OR gardening rust')).toEqual([2]);
  });

  it('finds other forms of words in the languages of stored entries', async () => {
    await db.entries.bulkPut(
      [
        entry(1, 'Las canciones del verano', { lang: 'es' }),
        entry(2, 'Running shoes reviewed', { lang: 'en-US' }),
        entry(3, 'Nichts zu sehen'),
      ].map(toStoredEntry),
    );
    const ids = async (q: string) => [...((await searchStore(db, q)) ?? [])].sort();
    expect(await ids('cancion veranos')).toEqual([1]);
    expect(await ids('runs shoe')).toEqual([2]);
    expect(await ids('-shoe')).toEqual([1, 3]);
  });

  it('filters stored entries as the server does', async () => {
    await db.entries.bulkPut(
      [
        entry(1, 'Rust compilers explained', { starred: true, unread: false, tags: ['lang'] }),
        entry(2, 'Gardening notes', { author: 'Rusty Nail', note: 'Plant in May', labels: [7] }),
        entry(3, 'Weekly digest', { published: true }),
        entry(4, 'Café culture', { sortAt: '2026-10-01T23:30:00.000Z' }),
      ].map(toStoredEntry),
    );
    await db.meta.put({
      key: 'query:labels',
      value: { data: [{ id: 7, caption: 'Read Later' }], at: NOW },
    });
    const ids = async (q: string) =>
      (
        await localList(db, {
          stream: {},
          view: 'all',
          order: 'newest',
          limit: 50,
          content: false,
          q,
        })
      ).entries.map((e) => e.id);
    expect(await ids('star:true')).toEqual([1]);
    expect(await ids('unread:true -pub:true')).toEqual([2, 4]);
    expect(await ids('title:NOTES')).toEqual([2]);
    expect(await ids('author:rusty')).toEqual([2]);
    expect(await ids('note:true')).toEqual([2]);
    expect(await ids('note:may')).toEqual([2]);
    expect(await ids('tag:LANG')).toEqual([1]);
    expect(await ids('label:"read later"')).toEqual([2]);
    expect(await ids('-label:"read later" -tag:lang')).toEqual([3, 4]);
    expect(await ids('rust star:false')).toEqual([2]);
  });
});

describe('the search index', () => {
  it('indexes headlines on upgrade, and content stored before search afterwards', async () => {
    db.close();
    await Dexie.delete(NAME);
    const old = new Dexie(NAME);
    old.version(2).stores({
      entries:
        'id, [subscriptionId+sortAt], [unread+sortAt], [starred+sortAt], [published+sortAt], readAt, *labels, *tags',
      contents: 'id, contentVersion, bytes',
      images: 'url, *entryIds, bytes',
      meta: 'key',
      outbox: '++seq',
    });
    const { words: _words, ...stored } = toStoredEntry(entry(1, 'Old headline'));
    await old.table('entries').put(stored);
    await old.table('contents').put(content(1, '<p>older body text</p>'));
    old.close();

    db = openOfflineDb(NAME);
    expect([...((await searchStore(db, 'headline')) ?? [])]).toEqual([1]);
    expect(await searchStore(db, 'body')).toEqual(new Set());
    expect(await indexStoredContents(db)).toBe(1);
    expect([...((await searchStore(db, 'body')) ?? [])]).toEqual([1]);
    expect(await indexBytes(db)).toBeGreaterThan(0);
    expect(await indexStoredContents(db)).toBe(0);
  });
});
