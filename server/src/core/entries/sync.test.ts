import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  categories,
  entries,
  feedSources,
  subscriptions,
  tombstones,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { syncedEntry as followUntil } from '../../test/sync.ts';
import { SyncService } from './sync.ts';

let database: TestDatabase;
let db: Db;
let sync: SyncService;
let userId: number;
let subscriptionId: number;
let sourceId: number;

async function addEntry(guid: string) {
  const [entry] = await db
    .insert(entries)
    .values({ feedSourceId: sourceId, guid, title: guid, contentHash: guid })
    .returning();
  const [row] = await db
    .insert(userEntries)
    .values({ userId, entryId: entry?.id ?? 0, subscriptionId, sortAt: new Date() })
    .returning();
  return row?.id ?? 0;
}

const syncedEntry = (id: number, since: string | undefined) => followUntil(sync, userId, id, since);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  sync = new SyncService(db);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
  const [source] = await db
    .insert(feedSources)
    .values({ url: 'https://s.example/rss' })
    .returning();
  sourceId = source?.id ?? 0;
  const [sub] = await db
    .insert(subscriptions)
    .values({ userId, feedSourceId: sourceId })
    .returning();
  subscriptionId = sub?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('SyncService', () => {
  it('returns everything first, then only changes and deletions', async () => {
    const first = await addEntry('a');
    const [category] = await db.insert(categories).values({ userId, title: 'C' }).returning();
    const full = await sync.changes(userId, undefined, 100);
    expect(full.entries.map((e) => e.id)).toEqual([first]);
    expect(full.categories.map((c) => c.title)).toEqual(['C']);
    expect(full.subscriptions.map((s) => s.subscription.id)).toEqual([subscriptionId]);
    expect(full.more).toBe(false);

    const idle = await sync.changes(userId, full.next, 100);
    expect([idle.entries, idle.categories, idle.subscriptions]).toEqual([[], [], []]);

    const second = await addEntry('b');
    await db.update(userEntries).set({ starred: true }).where(eq(userEntries.id, first));
    await db.delete(categories).where(eq(categories.id, category?.id ?? 0));
    const delta = await sync.changes(userId, idle.next, 100);
    expect(delta.entries.map((e) => [e.id, e.starred])).toEqual([
      [second, false],
      [first, true],
    ]);
    expect(delta.deleted).toEqual({
      categories: [category?.id],
      subscriptions: [],
      labels: [],
      entries: [],
    });

    await db.delete(subscriptions).where(eq(subscriptions.id, subscriptionId));
    await db.delete(userEntries).where(eq(userEntries.id, second));
    const removed = await sync.changes(userId, delta.next, 100);
    expect(removed.deleted).toEqual({
      categories: [],
      subscriptions: [subscriptionId],
      labels: [],
      entries: [second],
    });
    // The kept entry lost its subscription, which is a change.
    expect(removed.entries.map((e) => [e.id, e.subscriptionId])).toEqual([[first, null]]);
  });

  it('starts from a token at the present', async () => {
    const before = await addEntry('before');
    await db.insert(categories).values({ userId, title: 'Before' });
    const token = await sync.token();
    const after = await addEntry('after');
    await db.delete(userEntries).where(eq(userEntries.id, before));
    const delta = await sync.changes(userId, token, 100);
    expect(delta.entries.map((e) => e.id)).toEqual([after]);
    expect([delta.categories, delta.subscriptions]).toEqual([[], []]);
    expect(delta.deleted.entries).toEqual([before]);
  });

  it('syncs edited content and extracted full text, not fetches that change neither', async () => {
    const id = await addEntry('edited');
    const [row] = await db.select().from(userEntries).where(eq(userEntries.id, id));
    const entryId = row?.entryId ?? 0;
    const initial = await syncedEntry(id, undefined);

    await db
      .update(entries)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(entries.id, entryId));
    await db
      .update(entries)
      .set({ fullContentAt: sql`now()`, fullContentError: 'Timed out' })
      .where(eq(entries.id, entryId));
    const idle = await sync.changes(userId, initial.next, 100);
    expect(idle.entries).toEqual([]);

    await db
      .update(entries)
      .set({ title: 'Edited', contentHash: 'edited-2' })
      .where(eq(entries.id, entryId));
    const edited = await syncedEntry(id, idle.next);
    expect(edited.entry.title).toBe('Edited');
    expect(edited.entry.contentVersion).not.toBe(initial.entry.contentVersion);

    await db
      .update(entries)
      .set({ fullContent: '<p>Full</p>', fullContentAt: sql`now()`, fullContentError: null })
      .where(eq(entries.id, entryId));
    const extracted = await syncedEntry(id, edited.next);
    expect(extracted.entry.contentVersion).not.toBe(edited.entry.contentVersion);
  });

  it('carries the read time', async () => {
    const id = await addEntry('read');
    await db
      .update(userEntries)
      .set({ unread: false, readAt: sql`now()` })
      .where(eq(userEntries.id, id));
    const { entry } = await syncedEntry(id, undefined);
    expect(entry.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('pages entries without losing rows that share a timestamp', async () => {
    await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values(
          ['x', 'y', 'z'].map((guid) => ({ feedSourceId: sourceId, guid, contentHash: guid })),
        )
        .returning();
      await tx.insert(userEntries).values(
        (await tx.select().from(entries)).map((e) => ({
          userId,
          entryId: e.id,
          subscriptionId,
          sortAt: new Date(),
        })),
      );
      return entry;
    });
    const seen: number[] = [];
    let next: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await sync.changes(userId, next, 2);
      seen.push(...result.entries.map((e) => e.id));
      next = result.next;
      if (!result.more) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('holds back changes of transactions still in progress', async () => {
    const other = new pg.Client({ connectionString: database.url });
    await other.connect();
    try {
      await other.query('BEGIN');
      const base = await sync.changes(userId, undefined, 100);
      const [entry] = await db
        .insert(entries)
        .values({ feedSourceId: sourceId, guid: 'late', contentHash: 'late' })
        .returning();
      await other.query(
        `INSERT INTO user_entries (user_id, entry_id, subscription_id, sort_at) VALUES ($1, $2, $3, now())`,
        [userId, entry?.id, subscriptionId],
      );
      const during = await sync.changes(userId, base.next, 100);
      expect(during.entries).toEqual([]);
      await other.query('COMMIT');
      const after = await sync.changes(userId, during.next, 100);
      expect(after.entries).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it("isn't held back by another database's transactions", async () => {
    const elsewhere = await createTestDatabase({ migrate: false });
    const other = new pg.Client({ connectionString: elsewhere.url });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('CREATE TABLE held (i int)');
      const base = await sync.changes(userId, undefined, 100);
      const id = await addEntry('meanwhile');
      expect((await sync.changes(userId, base.next, 100)).entries.map((e) => e.id)).toEqual([id]);
    } finally {
      await other.end();
      await elsewhere.drop();
    }
  });

  it('syncs rows written after a token even when the clock stepped back', async () => {
    const { next } = await sync.changes(userId, undefined, 100);
    const [entry] = await db
      .insert(entries)
      .values({ feedSourceId: sourceId, guid: 'stepped', contentHash: 'stepped' })
      .returning();
    // Written after the token, with a time before it, as when the clock steps back in between.
    const [row] = await db
      .insert(userEntries)
      .values({
        userId,
        entryId: entry?.id ?? 0,
        subscriptionId,
        sortAt: new Date(),
        updatedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    expect((await sync.changes(userId, next, 100)).entries.map((e) => e.id)).toEqual([row?.id]);
  });

  it('takes rows with transaction ids from another cluster into a full sync', async () => {
    const [current] = (
      await db.execute<{ xid: string }>(sql`SELECT pg_current_xact_id()::text AS xid`)
    ).rows;
    const here = await addEntry('here');
    const [entry] = await db
      .insert(entries)
      .values({ feedSourceId: sourceId, guid: 'restored', contentHash: 'restored' })
      .returning();
    // A restore from a busier cluster keeps that cluster's ids, far ahead of this one's.
    const [restored] = await db
      .insert(userEntries)
      .values({
        userId,
        entryId: entry?.id ?? 0,
        subscriptionId,
        sortAt: new Date(),
        syncXid: Number(current?.xid) + 1_000_000,
      })
      .returning();
    const seen: number[] = [];
    let next: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await sync.changes(userId, next, 1);
      seen.push(...result.entries.map((e) => e.id));
      next = result.next;
      if (!result.more) break;
    }
    expect(seen).toEqual([here, restored?.id]);
    // The full sync hands over to changes from where it started.
    const later = await addEntry('later');
    expect((await sync.changes(userId, next, 100)).entries.map((e) => e.id)).toEqual([later]);
  });

  it('carries tokens from before sync_xid on to the rows written since, without a resync', async () => {
    // Such tokens hold the watermark as Postgres printed it.
    const [printed] = (
      await db.execute<{ t: string }>(sql`SELECT (now() - interval '1 hour')::text AS t`)
    ).rows;
    const since = new Date(printed?.t ?? '');
    const legacy = Buffer.from(JSON.stringify({ t: printed?.t, i: 0 })).toString('base64url');
    // Rows from before the migration have sync_xid 0; the client has those older than its token.
    const before = async (guid: string, updatedAt: Date) => {
      const [entry] = await db
        .insert(entries)
        .values({ feedSourceId: sourceId, guid, contentHash: guid })
        .returning();
      const [row] = await db
        .insert(userEntries)
        .values({
          userId,
          entryId: entry?.id ?? 0,
          subscriptionId,
          sortAt: new Date(),
          syncXid: 0,
          updatedAt,
        })
        .returning();
      return row?.id ?? 0;
    };
    await before('seen', new Date(since.getTime() - 60_000));
    const unseen = await before('unseen', new Date(since.getTime() + 60_000));
    const sinceMigration = await addEntry('new');

    const first = await sync.changes(userId, legacy, 100);
    expect(first.entries.map((e) => e.id)).toEqual([unseen]);
    expect(first.more).toBe(true);
    const second = await sync.changes(userId, first.next, 100);
    expect(second.entries.map((e) => e.id)).toEqual([sinceMigration]);
    expect(second.more).toBe(false);
  });

  it('requires a full resync for expired, unknown, and other copies’ tokens', async () => {
    const { next } = await sync.changes(userId, undefined, 100);
    const token = JSON.parse(Buffer.from(next, 'base64url').toString()) as {
      e: string;
      t: number;
    };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(token.t).toBeGreaterThan(0);
    for (const since of [
      encode({ ...token, t: token.t - 31 * 24 * 60 * 60 }),
      encode({ t: '2000-01-01 00:00:00+00', i: 0 }),
      encode({ ...token, e: 'another' }),
      'garbage',
    ])
      await expect(sync.changes(userId, since, 100)).rejects.toMatchObject({
        code: 'resync_required',
      });
  });

  it('prunes old tombstones and skips them for deleted users', async () => {
    await db.insert(tombstones).values({
      userId,
      entity: 'entry',
      entityId: 1,
      deletedAt: sql`now() - interval '40 days'`,
    });
    expect(await sync.pruneTombstones()).toBe(1);
    await addEntry('gone');
    await db.delete(users).where(eq(users.id, userId));
    expect(await db.select().from(tombstones)).toEqual([]);
  });
});
