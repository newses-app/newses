import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  enclosures,
  entries,
  entryTags,
  feedSources,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingRealtime } from '../../test/fakes.ts';
import { Ingester } from './ingest.ts';
import type { ParsedEntry } from './parse.ts';

let database: TestDatabase;
let db: Db;
let realtime: RecordingRealtime;
let ingester: Ingester;
let sourceId: number;
let alice: number;
let bob: number;

const entry = (overrides: Partial<ParsedEntry>): ParsedEntry => ({
  guid: null,
  link: null,
  title: null,
  author: null,
  content: null,
  publishedAt: new Date(),
  updatedAt: null,
  enclosures: [],
  categories: [],
  ...overrides,
});

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  realtime = new RecordingRealtime();
  ingester = new Ingester(db, realtime, {
    updateIntervalSeconds: 1800,
    purgeDays: 30,
    disableAfterFailures: 3,
  });
  const [source] = await db
    .insert(feedSources)
    .values({ url: 'https://f.example/rss' })
    .returning();
  sourceId = source?.id ?? 0;
  const created = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  alice = created[0]?.id ?? 0;
  bob = created[1]?.id ?? 0;
  await db.insert(subscriptions).values([
    { userId: alice, feedSourceId: sourceId },
    { userId: bob, feedSourceId: sourceId, purgeDays: 0 },
  ]);
});

afterAll(async () => {
  await database.drop();
});

describe('Ingester', () => {
  it('stores sanitised entries and delivers them unread to every subscriber', async () => {
    const result = await ingester.ingest(sourceId, 'https://f.example/', [
      entry({
        guid: 'g1',
        title: '<b>One</b>',
        link: 'https://f.example/1',
        content: '<p onclick="x()">Body</p>',
      }),
      entry({
        guid: 'g2',
        title: 'Two',
        enclosures: [
          {
            url: 'https://f.example/a.mp3',
            mimeType: 'audio/mpeg',
            length: 1,
            width: null,
            height: null,
            durationSeconds: 61.6,
          },
        ],
      }),
    ]);
    expect(result).toEqual({ inserted: 2, updated: 0 });
    const stored = await db.select().from(entries).orderBy(entries.guid);
    expect(stored.map((e) => [e.title, e.content])).toEqual([
      ['One', '<p>Body</p>'],
      ['Two', null],
    ]);
    expect(await db.select().from(enclosures)).toEqual([
      expect.objectContaining({ durationSeconds: 62 }),
    ]);
    const delivered = await db.select().from(userEntries);
    expect(delivered).toHaveLength(4);
    expect(delivered.every((e) => e.unread)).toBe(true);
    expect(realtime.published.map((p) => p.userId).sort()).toEqual([alice, bob].sort());
  });

  it('ignores unchanged entries and updates changed ones without re-delivering', async () => {
    const first = [entry({ guid: 'g1', title: 'Old', content: 'a' })];
    await ingester.ingest(sourceId, null, first);
    await db.update(userEntries).set({ unread: false });
    expect(await ingester.ingest(sourceId, null, first)).toEqual({ inserted: 0, updated: 0 });
    expect(
      await ingester.ingest(sourceId, null, [entry({ guid: 'g1', title: 'New', content: 'b' })]),
    ).toEqual({
      inserted: 0,
      updated: 1,
    });
    expect((await db.select().from(entries))[0]?.title).toBe('New');
    const delivered = await db.select().from(userEntries);
    expect(delivered).toHaveLength(2);
    expect(delivered.some((e) => e.unread)).toBe(false);
  });

  it('takes over an imported entry with the same link instead of duplicating it', async () => {
    const [imported] = await db
      .insert(entries)
      .values([
        {
          feedSourceId: sourceId,
          guid: 'ttrss:older',
          link: 'https://f.example/1',
          contentHash: 'a',
        },
        {
          feedSourceId: sourceId,
          guid: 'ttrss:newer',
          link: 'https://f.example/1',
          contentHash: 'b',
        },
      ])
      .returning()
      .then((rows) => rows.slice(1));
    await db
      .insert(userEntries)
      .values({ userId: alice, entryId: imported?.id ?? 0, sortAt: new Date(), unread: false });
    const result = await ingester.ingest(sourceId, null, [
      entry({ guid: 'g1', title: 'One', link: 'https://f.example/1', content: 'fresh' }),
      entry({ guid: 'g2', title: 'Two', link: 'https://f.example/2' }),
    ]);
    expect(result).toEqual({ inserted: 1, updated: 1 });
    const stored = await db.select().from(entries).orderBy(entries.id);
    expect(stored.map((e) => [e.guid, e.title])).toEqual([
      ['ttrss:older', null],
      ['g1', 'One'],
      ['g2', 'Two'],
    ]);
    expect(stored[1]?.id).toBe(imported?.id);
    // Alice keeps her read copy; bob receives only the new item.
    const delivered = await db.select().from(userEntries);
    expect(delivered.filter((e) => e.userId === alice).map((e) => [e.entryId, e.unread])).toEqual(
      expect.arrayContaining([
        [imported?.id, false],
        [stored[2]?.id, true],
      ]),
    );
    expect(delivered.filter((e) => e.userId === bob).map((e) => e.entryId)).toEqual([
      stored[2]?.id,
    ]);
  });

  it('derives stable identities for entries without GUIDs and drops in-document duplicates', async () => {
    const items = [
      entry({ title: 'No guid', link: 'https://f.example/x' }),
      entry({ guid: 'dup', title: 'First' }),
      entry({ guid: 'dup', title: 'Second' }),
      entry({}),
    ];
    expect(await ingester.ingest(sourceId, null, items)).toEqual({ inserted: 2, updated: 0 });
    expect(await ingester.ingest(sourceId, null, items)).toEqual({ inserted: 0, updated: 0 });
    const titles = (await db.select().from(entries)).map((e) => e.title).sort();
    expect(titles).toEqual(['First', 'No guid']);
  });

  it('withholds entries older than the purge age, per subscription', async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await ingester.ingest(sourceId, null, [entry({ guid: 'old', title: 'Old', publishedAt: old })]);
    // Alice purges after 30 days; Bob never purges.
    expect((await db.select().from(userEntries)).map((e) => e.userId)).toEqual([bob]);
  });

  it('clamps future dates and marks entries as seen', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await ingester.ingest(sourceId, null, [
      entry({ guid: 'f', title: 'Future', publishedAt: future }),
    ]);
    const [delivered] = await db.select().from(userEntries).where(eq(userEntries.userId, alice));
    expect(delivered?.sortAt.getTime()).toBeLessThanOrEqual(Date.now());
    await db.update(entries).set({ lastSeenAt: new Date(0) });
    await ingester.ingest(sourceId, null, [
      entry({ guid: 'f', title: 'Future', publishedAt: future }),
    ]);
    expect((await db.select().from(entries))[0]?.lastSeenAt.getTime()).toBeGreaterThan(0);
  });

  it('backfills existing entries for a new subscriber', async () => {
    await ingester.ingest(sourceId, null, [
      entry({ guid: 'a', title: 'A' }),
      entry({ guid: 'b', title: 'B' }),
    ]);
    const [carol] = await db
      .insert(users)
      .values({ login: 'carol', passwordHash: 'x' })
      .returning();
    const [sub] = await db
      .insert(subscriptions)
      .values({ userId: carol?.id ?? 0, feedSourceId: sourceId })
      .returning();
    await ingester.backfill(sub?.id ?? 0);
    expect(
      await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.userId, carol?.id ?? 0)),
    ).toHaveLength(2);
  });

  it('copies feed categories as tags to every subscriber, without overwriting later edits', async () => {
    await ingester.ingest(sourceId, null, [
      entry({ guid: 't', title: 'T', categories: ['Open Source', 'open source', 'Rust, Go'] }),
    ]);
    const tags = async (userId: number) =>
      (await db.select().from(entryTags).where(eq(entryTags.userId, userId)))
        .map((row) => row.tag)
        .sort();
    expect(await tags(alice)).toEqual(['open source', 'rust go']);
    expect(await tags(bob)).toEqual(['open source', 'rust go']);
    const [delivered] = await db.select().from(userEntries).where(eq(userEntries.userId, alice));
    // Tagging during fan-out does not rewrite the new user entries.
    expect(delivered?.updatedAt.getTime()).toBe(delivered?.createdAt.getTime());

    await db.delete(entryTags).where(eq(entryTags.userId, alice));
    await ingester.ingest(sourceId, null, [
      entry({ guid: 't', title: 'T changed', categories: ['Open Source', 'News'] }),
    ]);
    expect(await tags(alice)).toEqual([]);
    expect((await db.select().from(entries))[0]?.categories).toEqual(['open source', 'news']);
  });
});
