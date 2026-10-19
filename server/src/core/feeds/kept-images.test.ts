import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  entries,
  entryImages,
  entryLabels,
  feedSources,
  fetchHosts,
  imageCache,
  labels,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { FakeFetcher, rss } from '../../test/fake-fetcher.ts';
import { MemoryBlobStore } from '../../test/fakes.ts';
import { createTestServices } from '../../test/services.ts';
import { imageKey } from './images.ts';
import { KEPT_ENTRY, KEPT_ENTRY_IDS } from './purge.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CAT = 'https://img.example/cat.png';
const DOG = 'https://img.example/dog.png';
const FEED = 'https://pics.example/rss';

let database: TestDatabase;
let db: Db;
let services: ReturnType<typeof createTestServices>;
let fetcher: FakeFetcher;
let blobs: MemoryBlobStore;
let userId = 0;
let userEntryId = 0;

const keep = () => services.feeds.images.keep(10_000);
const cached = async (url: string) => {
  const [row] = await db
    .select()
    .from(imageCache)
    .where(eq(imageCache.key, imageKey(url)));
  return row;
};
const age = (days: number) =>
  db.update(imageCache).set({ fetchedAt: sql`now() - make_interval(days => ${days})` });
const setFlags = (changes: Partial<typeof userEntries.$inferInsert>) =>
  db.update(userEntries).set(changes).where(eq(userEntries.id, userEntryId));

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  await db.delete(imageCache);
  await db.delete(fetchHosts);
  fetcher = new FakeFetcher()
    .set(FEED, {
      body: rss('Pics', 'https://pics.example/', [
        { guid: '1', title: 'Photo', description: `<p>Look</p><img src="${CAT}">` },
      ]),
    })
    .set(CAT, { body: PNG, contentType: 'image/png' })
    .set(DOG, { body: PNG, contentType: 'image/png' });
  blobs = new MemoryBlobStore();
  services = createTestServices(db, fetcher, { blobs });
  userId = (await services.users.create('ivy', 'ivy password')).id;
  await services.feeds.subscriptions.subscribe(userId, FEED);
  const [row] = await db.select({ id: userEntries.id }).from(userEntries);
  userEntryId = row?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('kept images', () => {
  it("fetches a starred entry's images and keeps them after the publisher's copy is gone", async () => {
    expect(await keep()).toEqual({ indexed: 0, fetched: 0 });
    await services.entries.entries.setState(userId, [userEntryId], { starred: true });
    expect(await keep()).toEqual({ indexed: 1, fetched: 1 });
    expect(await cached(CAT)).toMatchObject({ failed: false });

    fetcher.routes.delete(CAT);
    await age(31);
    await services.feeds.images.purge();
    expect(await cached(CAT)).toBeDefined();
    expect(blobs.blobs.has(imageKey(CAT))).toBe(true);
    // Nothing more to do until the content changes.
    expect(await keep()).toEqual({ indexed: 0, fetched: 0 });
  });

  it('releases the images once no one keeps the entry', async () => {
    await services.entries.entries.setState(userId, [userEntryId], { starred: true });
    await keep();
    await services.entries.entries.setState(userId, [userEntryId], { starred: false });
    await age(31);
    expect(await services.feeds.images.purge()).toBe(1);
    expect(await cached(CAT)).toBeUndefined();
    expect(blobs.blobs.has(imageKey(CAT))).toBe(false);
    expect(await db.select().from(entryImages)).toEqual([]);
  });

  it('keeps the images of published, noted, labelled, and shared entries too', async () => {
    const [label] = await db
      .insert(labels)
      .values({ userId, caption: 'Keep', fgColor: '#000000', bgColor: '#ffffff' })
      .returning();
    const kinds: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['published', () => setFlags({ published: true }), () => setFlags({ published: false })],
      ['noted', () => setFlags({ note: 'mine' }), () => setFlags({ note: null })],
      [
        'shared',
        () => setFlags({ shareId: '6f1c2b0e-4a5d-4e3f-9b8a-7c6d5e4f3a2b' }),
        () => setFlags({ shareId: null }),
      ],
      [
        'labelled',
        () => db.insert(entryLabels).values({ userEntryId, labelId: label?.id ?? 0 }),
        () => db.delete(entryLabels),
      ],
    ];
    for (const [kind, on, off] of kinds) {
      await on();
      await keep();
      await age(31);
      await services.feeds.images.purge();
      expect(await cached(CAT), kind).toBeDefined();
      await off();
    }
  });

  it("lists an entry's images again when its content changes", async () => {
    await services.entries.entries.setState(userId, [userEntryId], { starred: true });
    await keep();
    await db
      .update(entries)
      .set({ content: `<img src="${DOG}">`, contentHash: 'changed' })
      .where(sql`true`);
    expect(await keep()).toEqual({ indexed: 1, fetched: 1 });
    const listed = await db.select({ url: entryImages.url }).from(entryImages);
    expect(listed).toEqual([{ url: DOG }]);
    await age(31);
    await services.feeds.images.purge();
    expect(await cached(DOG)).toBeDefined();
    expect(await cached(CAT)).toBeUndefined();
  });

  it('stops asking for an image that keeps failing, and waits out paused hosts', async () => {
    fetcher.routes.delete(CAT);
    await services.entries.entries.setState(userId, [userEntryId], { starred: true });
    await db
      .insert(fetchHosts)
      .values({ host: 'img.example', blockedUntil: sql`now() + interval '1 hour'` });
    await keep();
    expect(await cached(CAT)).toBeUndefined();

    await db.delete(fetchHosts);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await keep();
      await db.update(imageCache).set({ fetchedAt: sql`now() - interval '25 hours'` });
    }
    expect(await cached(CAT)).toMatchObject({ failed: true, attempts: 3 });
    expect(fetcher.requested.filter((url) => url === CAT)).toHaveLength(3);
  });

  it('agrees with purge on which entries are kept', async () => {
    const kept = async () => {
      const ids = await db.execute<{ entry_id: string }>(
        sql`SELECT entry_id FROM ${KEPT_ENTRY_IDS} k ORDER BY 1`,
      );
      const byRow = await db.execute<{ entry_id: string }>(
        sql`SELECT DISTINCT ue.entry_id FROM user_entries ue WHERE ${KEPT_ENTRY} ORDER BY 1`,
      );
      return [ids.rows.map((r) => r.entry_id), byRow.rows.map((r) => r.entry_id)];
    };
    const [label] = await db
      .insert(labels)
      .values({ userId, caption: 'Keep', fgColor: '#000000', bgColor: '#ffffff' })
      .returning();
    for (const change of [
      () => setFlags({ starred: true }),
      () => setFlags({ starred: false, published: true }),
      () => setFlags({ published: false, note: 'x' }),
      () => setFlags({ note: null }),
      () => db.insert(entryLabels).values({ userEntryId, labelId: label?.id ?? 0 }),
    ]) {
      await change();
      const [ids, byRow] = await kept();
      expect(ids).toEqual(byRow);
    }
  });
});
