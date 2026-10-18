import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  enclosures,
  entries,
  feedSources,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { archiveRow } from '../../test/archive-reader-contract.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { syncedEntry } from '../../test/sync.ts';
import { MemoryArchive, RecordingRealtime } from '../../test/fakes.ts';
import { createEntryServices } from './index.ts';

let database: TestDatabase;
let db: Db;
let services: ReturnType<typeof createEntryServices>;
let writer: MemoryArchive;
let alice: number;
let bob: number;
let aliceSub: number;
let ids: Record<string, number>;

const ONE = 'https://one.example/rss';
const TWO = 'https://two.example/rss';
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  writer = new MemoryArchive();
  services = createEntryServices(db, new RecordingRealtime(), writer);

  const [a, b] = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  alice = a?.id ?? 0;
  bob = b?.id ?? 0;
  const [one, two] = await db
    .insert(feedSources)
    .values([
      { url: ONE, title: 'One' },
      { url: TWO, title: 'Two' },
    ])
    .returning();
  const [sub, bobSub] = await db
    .insert(subscriptions)
    .values([
      { userId: alice, feedSourceId: one?.id ?? 0, title: 'My one' },
      { userId: bob, feedSourceId: one?.id ?? 0 },
      { userId: bob, feedSourceId: two?.id ?? 0 },
    ])
    .returning();
  aliceSub = sub?.id ?? 0;
  // `held` is in alice's feed; bob holds `shared`, which alice never received.
  const rows = await db
    .insert(entries)
    .values([
      {
        feedSourceId: one?.id ?? 0,
        guid: 'held',
        title: 'Held',
        contentHash: 'h',
        publishedAt: at('2024-07-01T00:00:00Z'),
        fetchedAt: at('2024-07-01T00:00:00Z'),
      },
      {
        feedSourceId: one?.id ?? 0,
        guid: 'shared',
        title: 'Shared apple',
        content: '<p>Apple cake</p>',
        contentHash: 'h',
        publishedAt: at('2024-06-15T00:00:00Z'),
        fetchedAt: at('2024-06-16T00:00:00Z'),
      },
    ])
    .returning();
  ids = { held: rows[0]?.id ?? 0, shared: rows[1]?.id ?? 0 };
  await db
    .insert(enclosures)
    .values({ entryId: ids.shared ?? 0, url: 'https://one.example/s.mp3' });
  await db.insert(userEntries).values([
    { userId: alice, entryId: ids.held ?? 0, subscriptionId: aliceSub, sortAt: new Date() },
    {
      userId: bob,
      entryId: ids.shared ?? 0,
      subscriptionId: bobSub?.id ?? 0,
      sortAt: new Date(),
    },
  ]);

  await writer.write([
    archiveRow({
      id: 900_001,
      feedUrl: ONE,
      guid: 'purged',
      title: 'Purged apple',
      link: 'https://one.example/purged',
      content: '<p>Gone</p>',
      text: 'Gone',
      publishedAt: at('2024-05-02T00:00:00Z'),
      fetchedAt: at('2024-05-02T00:00:00Z'),
      sortAt: at('2024-05-02T00:00:00Z'),
      enclosures: [
        {
          url: 'https://one.example/p.mp3',
          mimeType: 'audio/mpeg',
          length: 5,
          width: null,
          height: null,
          durationSeconds: 60,
        },
      ],
    }),
    archiveRow({
      feedUrl: ONE,
      guid: 'imported',
      title: 'Imported',
      sortAt: at('2024-04-01T00:00:00Z'),
    }),
    // Archived once, then back in the database: the database's copy wins.
    archiveRow({
      feedUrl: ONE,
      guid: 'shared',
      title: 'Stale',
      sortAt: at('2024-06-15T00:00:00Z'),
    }),
    // Alice does not subscribe to two.
    archiveRow({
      feedUrl: TWO,
      guid: 'other',
      title: 'Other apple',
      sortAt: at('2024-05-05T00:00:00Z'),
    }),
  ]);
});

const titles = (list: { title: string | null }[]) => list.map((e) => e.title);

describe('ArchiveService', () => {
  it("lists entries of the user's feeds they do not hold, and archived ones, newest first", async () => {
    const page = await services.archive.list(alice, { limit: 10 });
    expect(titles(page.entries)).toEqual(['Shared apple', 'Purged apple', 'Imported']);
    expect(page.cursor).toBeNull();
    expect(page.entries[0]).toMatchObject({
      archived: true,
      subscriptionId: aliceSub,
      feedTitle: 'My one',
      excerpt: 'Apple cake',
      publishedAt: '2024-06-15T00:00:00.000Z',
      sortAt: '2024-06-15T00:00:00.000Z',
    });
    expect(page.entries[1]).toMatchObject({ feedTitle: 'My one', excerpt: 'Gone' });
  });

  it('pages with a cursor across the database and the archive', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await services.archive.list(alice, { limit: 1, cursor });
      seen.push(...titles(page.entries).map(String));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['Shared apple', 'Purged apple', 'Imported']);
  });

  it('searches both, and limits to one subscription', async () => {
    expect(titles((await services.archive.list(alice, { q: 'apple', limit: 10 })).entries)).toEqual(
      ['Shared apple', 'Purged apple'],
    );
    expect(
      (await services.archive.list(alice, { subscriptionId: aliceSub, limit: 10 })).entries,
    ).toHaveLength(3);
    await expect(
      services.archive.list(alice, { subscriptionId: aliceSub + 1000, limit: 10 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await services.archive.list(bob, { q: 'other', limit: 10 })).entries).toHaveLength(1);
  });

  it('gets one article with content and enclosures, from either store', async () => {
    const page = await services.archive.list(alice, { limit: 10 });
    const [shared, purged] = page.entries;
    expect(await services.archive.get(alice, shared?.key ?? '')).toMatchObject({
      title: 'Shared apple',
      content: '<p>Apple cake</p>',
      enclosures: [{ url: 'https://one.example/s.mp3', length: null }],
    });
    expect(await services.archive.get(alice, purged?.key ?? '')).toMatchObject({
      title: 'Purged apple',
      content: '<p>Gone</p>',
      enclosures: [{ url: 'https://one.example/p.mp3', length: 5, durationSeconds: 60 }],
    });
    // Only subscribers reach a feed's archive.
    const other = (await services.archive.list(bob, { q: 'other', limit: 10 })).entries[0];
    await expect(services.archive.get(alice, other?.key ?? '')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(services.archive.get(alice, 'nonsense')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('restores an archived article with its id and enclosures, into the feed and sync', async () => {
    const before = await services.sync.changes(alice, undefined, 100);
    const purged = (await services.archive.list(alice, { q: 'purged', limit: 1 })).entries[0];
    const entry = await services.archive.restore(alice, purged?.key ?? '', { starred: true });
    expect(entry).toMatchObject({
      title: 'Purged apple',
      subscriptionId: aliceSub,
      unread: false,
      starred: true,
      sortAt: '2024-05-02T00:00:00.000Z',
      enclosures: [{ url: 'https://one.example/p.mp3', mimeType: 'audio/mpeg' }],
    });
    const [restored] = await db.select().from(entries).where(eq(entries.guid, 'purged'));
    expect(restored?.id).toBe(900_001);
    expect(titles((await services.archive.list(alice, { limit: 10 })).entries)).toEqual([
      'Shared apple',
      'Imported',
    ]);
    expect((await syncedEntry(services.sync, alice, entry.id, before.next)).entry.starred).toBe(
      true,
    );
    // Restoring again changes nothing but the state.
    const again = await services.archive.restore(alice, purged?.key ?? '', { starred: false });
    expect(again).toMatchObject({ id: entry.id, starred: false });
  });

  it("restores onto the database's copy, and a new id when the old one is taken", async () => {
    const page = await services.archive.list(alice, { limit: 10 });
    const shared = await services.archive.restore(alice, page.entries[0]?.key ?? '', {
      published: true,
    });
    const [ue] = await db.select().from(userEntries).where(eq(userEntries.id, shared.id));
    expect(ue?.entryId).toBe(ids.shared);
    expect(await db.select().from(entries)).toHaveLength(2);

    await writer.write([
      archiveRow({ id: ids.held ?? 0, feedUrl: ONE, guid: 'clash', title: 'Clash' }),
    ]);
    const clash = (await services.archive.list(alice, { q: 'clash', limit: 1 })).entries[0];
    const restored = await services.archive.restore(alice, clash?.key ?? '', { unread: true });
    expect(restored).toMatchObject({ title: 'Clash', unread: true });
    const [row] = await db.select().from(entries).where(eq(entries.guid, 'clash'));
    expect(row?.id).not.toBe(ids.held);
  });
});
