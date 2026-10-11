import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  enclosures,
  entries,
  entryLabels,
  feedSources,
  labels,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MemoryArchiveWriter, MemoryBlobStore } from '../../test/fakes.ts';
import type { ArchiveRow } from '../ports.ts';
import { faviconKey } from './favicons.ts';
import { Purger } from './purge.ts';

let database: TestDatabase;
let db: Db;
let blobs: MemoryBlobStore;
let purger: Purger;
let userId: number;

const SETTINGS = { updateIntervalSeconds: 1800, purgeDays: 30, disableAfterFailures: 3 };

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  blobs = new MemoryBlobStore();
  purger = new Purger(db, blobs, SETTINGS);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

async function feedWith(
  purgeDays: number | null,
  items: {
    guid: string;
    age: number;
    starred?: boolean;
    published?: boolean;
    note?: string;
    labelled?: boolean;
    shared?: boolean;
  }[],
) {
  const [source] = await db
    .insert(feedSources)
    .values({ url: `https://${String(Math.random())}.example/rss` })
    .returning();
  const [sub] = await db
    .insert(subscriptions)
    .values({ userId, feedSourceId: source?.id ?? 0, purgeDays })
    .returning();
  for (const item of items) {
    const [e] = await db
      .insert(entries)
      .values({ feedSourceId: source?.id ?? 0, guid: item.guid, contentHash: 'h' })
      .returning();
    const [ue] = await db
      .insert(userEntries)
      .values({
        userId,
        entryId: e?.id ?? 0,
        subscriptionId: sub?.id ?? 0,
        sortAt: daysAgo(item.age),
        starred: item.starred ?? false,
        published: item.published ?? false,
        note: item.note ?? null,
        shareId: item.shared ? crypto.randomUUID() : null,
      })
      .returning();
    if (item.labelled) {
      const [label] = await db
        .insert(labels)
        .values({ userId, caption: item.guid, fgColor: '#000000', bgColor: '#ffffff' })
        .returning();
      await db.insert(entryLabels).values({ userEntryId: ue?.id ?? 0, labelId: label?.id ?? 0 });
    }
  }
  return { source, sub };
}

const guids = async () =>
  (
    await db
      .select({ guid: entries.guid })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
  )
    .map((r) => r.guid)
    .sort();

describe('Purger', () => {
  it('purges by age, keeping starred, published, noted, labelled, and shared entries', async () => {
    await feedWith(null, [
      { guid: 'global-new', age: 10 },
      { guid: 'global-old', age: 40 },
      { guid: 'global-starred', age: 400, starred: true },
      { guid: 'global-published', age: 400, published: true },
      { guid: 'global-noted', age: 400, note: 'keep' },
      { guid: 'global-labelled', age: 400, labelled: true },
      { guid: 'global-shared', age: 400, shared: true },
    ]);
    await feedWith(5, [{ guid: 'short-old', age: 6 }]);
    await feedWith(0, [{ guid: 'never', age: 4000 }]);

    const result = await purger.purge();
    expect(result.userEntries).toBe(2);
    expect(await guids()).toEqual([
      'global-labelled',
      'global-new',
      'global-noted',
      'global-published',
      'global-shared',
      'global-starred',
      'never',
    ]);
  });

  it('deletes unreferenced entries only after they leave the feed', async () => {
    const { source } = await feedWith(null, [{ guid: 'old', age: 40 }]);
    await purger.purge();
    expect(
      await db
        .select()
        .from(entries)
        .where(eq(entries.feedSourceId, source?.id ?? 0)),
    ).toHaveLength(1);
    await db.update(entries).set({ lastSeenAt: daysAgo(8) });
    expect((await purger.purge()).entries).toBe(1);
  });

  it('deletes unsubscribed sources unless they hold kept entries', async () => {
    const orphan = await feedWith(null, []);
    const kept = await feedWith(null, [{ guid: 'star', age: 1, starred: true }]);
    await blobs.put(faviconKey(orphan.source?.id ?? 0), {
      data: new Uint8Array([1]),
      contentType: 'image/png',
    });
    await db.delete(subscriptions);

    expect((await purger.purge()).feedSources).toBe(1);
    const remaining = (await db.select().from(feedSources)).map((s) => s.id);
    expect(remaining).toEqual([kept.source?.id]);
    expect(blobs.blobs.size).toBe(0);
  });

  describe('with an archive', () => {
    const PUBLISHED = new Date('2024-05-06T07:08:09.123Z');
    let archive: MemoryArchiveWriter;

    beforeEach(() => {
      archive = new MemoryArchiveWriter();
      purger = new Purger(db, blobs, SETTINGS, { archive });
    });

    /** An entry no user holds, last seen `seenDaysAgo` days ago. */
    async function orphan(feedSourceId: number, guid: string, seenDaysAgo: number) {
      const [entry] = await db
        .insert(entries)
        .values({
          feedSourceId,
          guid,
          contentHash: 'h',
          title: guid,
          content: '<p>Hello &amp; welcome</p>',
          publishedAt: PUBLISHED,
          fetchedAt: new Date(PUBLISHED.getTime() + 60_000),
          lastSeenAt: daysAgo(seenDaysAgo),
        })
        .returning();
      return entry?.id ?? 0;
    }

    it('archives unreferenced entries, with their feed and enclosures, before deleting them', async () => {
      const { source } = await feedWith(null, [{ guid: 'kept', age: 400, starred: true }]);
      const sourceId = source?.id ?? 0;
      const gone = await orphan(sourceId, 'gone', 8);
      await orphan(sourceId, 'still-in-feed', 1);
      await db
        .insert(enclosures)
        .values({ entryId: gone, url: 'https://cdn.example/a.mp3', length: 5 });

      const result = await purger.purge();
      expect(result).toMatchObject({ entries: 1, archived: 1 });
      expect(archive.rows).toHaveLength(1);
      expect(archive.rows[0]).toMatchObject<Partial<ArchiveRow>>({
        id: gone,
        feedUrl: source?.url ?? '',
        guid: 'gone',
        title: 'gone',
        text: 'Hello & welcome',
        publishedAt: PUBLISHED,
        sortAt: PUBLISHED,
        enclosures: [
          {
            url: 'https://cdn.example/a.mp3',
            mimeType: null,
            length: 5,
            width: null,
            height: null,
            durationSeconds: null,
          },
        ],
      });
      expect((await db.select().from(entries)).map((e) => e.guid).sort()).toEqual([
        'kept',
        'still-in-feed',
      ]);
    });

    it('keeps entries when the archive cannot be written', async () => {
      const { source } = await feedWith(null, []);
      await orphan(source?.id ?? 0, 'gone', 8);
      archive.fail = true;
      await expect(purger.purge()).rejects.toThrow('archive unavailable');
      expect(await db.select().from(entries)).toHaveLength(1);
    });

    it('keeps entries that came back into use while being archived', async () => {
      const { source, sub } = await feedWith(null, []);
      const entryId = await orphan(source?.id ?? 0, 'revived', 8);
      const writer = {
        write: async (rows: ArchiveRow[]) => {
          await db
            .insert(userEntries)
            .values({ userId, entryId, subscriptionId: sub?.id ?? 0, sortAt: new Date() });
          await archive.write(rows);
        },
      };
      purger = new Purger(db, blobs, SETTINGS, { archive: writer });
      expect(await purger.purge()).toMatchObject({ entries: 0, archived: 1 });
      expect(await db.select().from(entries)).toHaveLength(1);
    });

    it('archives the entries of abandoned sources first, whenever they were seen', async () => {
      const { source } = await feedWith(null, []);
      await orphan(source?.id ?? 0, 'recent', 0);
      await db.delete(subscriptions);

      expect(await purger.purge()).toMatchObject({ entries: 1, archived: 1, feedSources: 1 });
      expect(archive.rows.map((r) => r.guid)).toEqual(['recent']);
      expect(await db.select().from(feedSources)).toHaveLength(0);
    });

    it('leaves what it has no time to archive for the next run', async () => {
      const { source } = await feedWith(null, []);
      await orphan(source?.id ?? 0, 'gone', 8);
      await db.delete(subscriptions);
      purger = new Purger(db, blobs, SETTINGS, { archive, archiveBudgetMs: 0 });

      expect(await purger.purge()).toMatchObject({ entries: 0, archived: 0, feedSources: 0 });
      expect(await db.select().from(entries)).toHaveLength(1);
      expect(await db.select().from(feedSources)).toHaveLength(1);
    });
  });
});
