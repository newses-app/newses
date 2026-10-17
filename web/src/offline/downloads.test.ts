import 'fake-indexeddb/auto';
import type { Entry, EntryContent } from '@newses/shared';
import { createApiClient } from '@newses/shared/client';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOfflineDb, type OfflineDb, toStoredEntry } from './db.ts';
import { downloadContents, downloadImages, storedBytes } from './downloads.ts';

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

const content = (id: number, images: EntryContent['images'] = []): EntryContent => ({
  id,
  contentVersion: 'v1',
  content: `<p>${'x'.repeat(10)}</p>`,
  fullContent: null,
  enclosures: [],
  images,
});

let db: OfflineDb;

beforeEach(() => {
  db = openOfflineDb('newses-downloads');
});

afterEach(async () => {
  db.close();
  await Dexie.delete('newses-downloads');
});

function server(answer: (ids: number[]) => { entries: EntryContent[]; deferred?: number[] }) {
  const asked: number[][] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const { ids } = JSON.parse(init?.body as string) as { ids: number[] };
    asked.push(ids);
    const { entries, deferred = [] } = answer(ids);
    return Promise.resolve(Response.json({ entries, missing: [], deferred }));
  };
  return { api: createApiClient({ baseUrl: 'https://r.example', token: 't', fetch }), asked };
}

describe('downloadContents', () => {
  it('asks for unread newest first, then starred, skipping current copies, and retries deferred ids', async () => {
    await db.entries.bulkPut(
      [entry(1), entry(2), entry(3, { unread: false, starred: true }), entry(4)].map(toStoredEntry),
    );
    await db.contents.put({ ...content(4), bytes: 1 });
    let first = true;
    const { api, asked } = server((ids) => {
      if (first) {
        first = false;
        return { entries: [content(ids[0] ?? 0)], deferred: ids.slice(1) };
      }
      return { entries: ids.map((id) => content(id)) };
    });
    expect(await downloadContents({ api, db, server: '', images: false })).toBe(3);
    expect(asked).toEqual([
      [1, 2, 3],
      [2, 3],
    ]);
    expect(await db.contents.get(1)).toMatchObject({ contentVersion: 'v1', bytes: 17 });
  });

  it('stops at the storage limit, and fetches a newer version', async () => {
    await db.entries.bulkPut([entry(1, { contentVersion: 'v2' }), entry(2)].map(toStoredEntry));
    await db.contents.put({ ...content(1), bytes: 17 });
    const { api, asked } = server((ids) => ({ entries: ids.map((id) => content(id)) }));
    expect(await downloadContents({ api, db, server: '', images: false, limitBytes: 10 })).toBe(0);
    expect(asked).toEqual([]);
    await downloadContents({ api, db, server: '', images: false });
    expect(asked).toEqual([[1, 2]]);
  });
});

describe('downloadImages', () => {
  it('stores images once per URL, one host at a time, and remembers failures', async () => {
    await db.entries.bulkPut([entry(1), entry(2)].map(toStoredEntry));
    const img = (host: string, name: string) => ({
      url: `https://${host}/${name}`,
      proxy: `/api/v1/images/s/${host}-${name}`,
    });
    await db.contents.bulkPut([
      {
        ...content(1, [
          img('a.example', '1.png'),
          img('a.example', '2.png'),
          img('b.example', 'bad.png'),
        ]),
        bytes: 1,
      },
      { ...content(2, [img('a.example', '1.png')]), bytes: 1 },
    ]);
    const active = new Map<string, number>();
    let most = 0;
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      asked.push(url);
      const host = url.includes('a.example') ? 'a' : 'b';
      active.set(host, (active.get(host) ?? 0) + 1);
      most = Math.max(most, active.get(host) ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.set(host, (active.get(host) ?? 1) - 1);
      return url.includes('bad')
        ? new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } })
        : new Response(new Blob([new Uint8Array(100)]), {
            headers: { 'content-type': 'image/png' },
          });
    };
    const options = {
      api: server(() => ({ entries: [] })).api,
      db,
      server: 'https://r.example',
      images: true,
      fetch,
      now: () => NOW,
    };

    expect(await downloadImages(options)).toBe(2);
    expect(most).toBe(1);
    expect(asked.every((u) => u.startsWith('https://r.example/api/v1/images/'))).toBe(true);
    expect((await db.images.get('https://a.example/1.png'))?.entryIds.sort()).toEqual([1, 2]);
    expect(await storedBytes(db)).toBe(202);

    asked.length = 0;
    expect(await downloadImages(options)).toBe(0);
    expect(asked).toEqual([]);
    expect(await downloadImages({ ...options, images: false })).toBe(0);
  });
});
