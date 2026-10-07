import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { entries, feedSources, subscriptions, userEntries, users } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MemoryBlobStore } from '../../test/fakes.ts';
import { faviconKey } from './favicons.ts';
import { Purger } from './purge.ts';

let database: TestDatabase;
let db: Db;
let blobs: MemoryBlobStore;
let purger: Purger;
let userId: number;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  blobs = new MemoryBlobStore();
  purger = new Purger(db, blobs, {
    updateIntervalSeconds: 1800,
    purgeDays: 30,
    disableAfterFailures: 3,
  });
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

async function feedWith(
  purgeDays: number | null,
  items: { guid: string; age: number; starred?: boolean; published?: boolean; note?: string }[],
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
    await db.insert(userEntries).values({
      userId,
      entryId: e?.id ?? 0,
      subscriptionId: sub?.id ?? 0,
      sortAt: daysAgo(item.age),
      starred: item.starred ?? false,
      published: item.published ?? false,
      note: item.note ?? null,
    });
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
  it('purges by global and per-feed age, keeping starred, published, and noted entries', async () => {
    await feedWith(null, [
      { guid: 'global-new', age: 10 },
      { guid: 'global-old', age: 40 },
      { guid: 'global-starred', age: 400, starred: true },
      { guid: 'global-published', age: 400, published: true },
      { guid: 'global-noted', age: 400, note: 'keep' },
    ]);
    await feedWith(5, [{ guid: 'short-old', age: 6 }]);
    await feedWith(0, [{ guid: 'never', age: 4000 }]);

    const result = await purger.purge();
    expect(result.userEntries).toBe(2);
    expect(await guids()).toEqual([
      'global-new',
      'global-noted',
      'global-published',
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
});
