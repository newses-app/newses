import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Ingester } from '../../core/feeds/ingest.ts';
import { createDb, type Db } from '../../db/client.ts';
import {
  enclosures,
  entries,
  feedSources,
  importMap,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MemoryArchive, RecordingRealtime } from '../../test/fakes.ts';
import { createTtrssSource } from '../../test/ttrss-source.ts';
import { type ImportOptions, importTtrss } from '../importer.ts';
import { TtrssSource } from '../source.ts';
import { IMPORT_STEPS } from '../steps.ts';
import { ARCHIVED_ENTRIES, durationSeconds } from './entries.ts';

let target: TestDatabase;
let sourceDb: TestDatabase;
let db: Db;

const ago = (interval: string) => `(now() AT TIME ZONE 'UTC') - interval '${interval}'`;

/**
 * pat and sam subscribe to one feed; pat also has an HTTP-auth feed (skipped) and an archived
 * feed, and published a URL that belongs to no feed. Article A is copied for both users, as
 * TTRSS does.
 */
const SOURCE_ROWS = `
  INSERT INTO ttrss_users (id, login, pwd_hash) VALUES (2, 'pat', 'x'), (3, 'sam', 'x');
  INSERT INTO ttrss_feeds (id, owner_uid, title, feed_url, auth_login) VALUES
    (1, 2, 'One', 'https://one.example/rss', ''), (2, 3, 'One', 'https://one.example/rss', ''),
    (3, 2, 'Private', 'https://private.example/rss', 'me');
  INSERT INTO ttrss_archived_feeds (id, owner_uid, created, title, feed_url) VALUES
    (7, 2, now(), 'Gone', 'https://gone.example/rss');
  INSERT INTO ttrss_entries (id, title, guid, link, updated, content, content_hash, date_entered,
      date_updated, author) VALUES
    (1, 'A', 'g1', 'https://one.example/a', ${ago('1 hour')}, '<p>A<script>x()</script></p>', 'h', ${ago('1 hour')}, ${ago('1 hour')}, 'Ann'),
    (2, 'A', 'g2', 'https://one.example/a', ${ago('1 hour')}, '<p>A<script>x()</script></p>', 'h', ${ago('50 minutes')}, ${ago('1 hour')}, 'Ann'),
    (3, 'Old', 'g3', 'https://one.example/old', ${ago('100 days')}, '', 'h', ${ago('100 days')}, ${ago('100 days')}, ''),
    (4, 'Old starred', 'g4', 'https://one.example/old-starred', ${ago('100 days')}, '', 'h', ${ago('100 days')}, ${ago('100 days')}, ''),
    (5, 'Private', 'g5', 'https://private.example/1', ${ago('1 hour')}, '', 'h', ${ago('1 hour')}, ${ago('1 hour')}, ''),
    (6, 'Archived', 'g6', 'https://gone.example/1', ${ago('200 days')}, '', 'h', ${ago('200 days')}, ${ago('200 days')}, ''),
    (7, 'Orphan', 'g7', 'https://nowhere.example/1', ${ago('1 hour')}, '', 'h', ${ago('1 hour')}, ${ago('1 hour')}, ''),
    (8, 'Read', 'g8', 'https://one.example/read', ${ago('10 days')}, '', 'h', ${ago('10 days')}, ${ago('10 days')}, ''),
    (9, 'Future', 'g9', 'https://one.example/future', (now() AT TIME ZONE 'UTC') + interval '3 days', '', 'h', ${ago('1 hour')}, ${ago('1 hour')}, ''),
    (10, 'Old noted', 'g10', 'https://one.example/old-noted', ${ago('100 days')}, '', 'h', ${ago('100 days')}, ${ago('100 days')}, ''),
    (11, 'Shared', 'SHA1:g11', 'https://shared.example/post/1', ${ago('300 days')}, '', 'h', ${ago('300 days')}, ${ago('300 days')}, '');
  INSERT INTO ttrss_enclosures (content_url, content_type, title, duration, width, height, post_id) VALUES
    ('https://one.example/a.mp3', 'audio/mpeg', '', '1:02', 0, 0, 1);
  INSERT INTO ttrss_user_entries (int_id, ref_id, uuid, feed_id, orig_feed_id, owner_uid, marked,
      published, tag_cache, label_cache, last_read, unread, note) VALUES
    (1, 1, '', 1, NULL, 2, false, false, '', '', NULL, true, NULL),
    (2, 2, '', 2, NULL, 3, true, false, '', '', ${ago('5 minutes')}, false, NULL),
    (3, 3, '', 1, NULL, 2, false, false, '', '', NULL, true, NULL),
    (4, 4, '', 1, NULL, 2, true, false, '', '', NULL, true, NULL),
    (5, 5, '', 3, NULL, 2, false, false, '', '', NULL, true, NULL),
    (6, 6, '', NULL, 7, 2, true, false, '', '', NULL, false, NULL),
    (7, 7, '', NULL, NULL, 2, false, false, '', '', NULL, true, NULL),
    (8, 8, '', 1, NULL, 2, false, true, '', '', ${ago('9 days')}, false, NULL),
    (9, 9, '', 1, NULL, 2, false, false, '', '', NULL, true, NULL),
    (10, 10, '', 1, NULL, 2, false, false, '', '', NULL, true, 'remember this'),
    (11, 11, '', NULL, NULL, 2, false, true, '', '', NULL, false, NULL);
  INSERT INTO ttrss_tags (tag_name, owner_uid, post_int_id) VALUES ('news', 2, 1);`;

async function run(changes: Partial<ImportOptions> = {}, archive: MemoryArchive | null = null) {
  const source = await TtrssSource.open(sourceDb.url);
  try {
    return await importTtrss(
      { db, source, steps: IMPORT_STEPS, purgeDays: 60, archive },
      { dryRun: false, force: false, ...changes },
    );
  } finally {
    await source.close();
  }
}

const userId = async (login: string) =>
  (await db.select().from(users).where(eq(users.login, login)))[0]?.id ?? 0;

/** The user's entries by title, with their state. */
async function entriesOf(login: string) {
  const rows = await db
    .select({ title: entries.title, ue: userEntries, entry: entries })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(eq(userEntries.userId, await userId(login)));
  return new Map(rows.map((r) => [r.title ?? '', r]));
}

beforeAll(async () => {
  target = await createTestDatabase();
  db = createDb(target.pool);
  sourceDb = await createTtrssSource(151);
  await sourceDb.pool.query(SOURCE_ROWS);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  await db.delete(importMap);
});

afterAll(async () => {
  await sourceDb.drop();
  await target.drop();
});

describe('TTRSS entries import', () => {
  it('imports entries with their state, sharing copies of one article between users', async () => {
    const report = await run();
    expect(report.reconciled).toBe(true);
    const pat = await entriesOf('pat');
    expect([...pat.keys()].sort()).toEqual([
      'A',
      'Archived',
      'Future',
      'Old noted',
      'Old starred',
      'Read',
      'Shared',
    ]);
    const a = pat.get('A');
    expect(a?.entry).toMatchObject({
      link: 'https://one.example/a',
      content: '<p>A</p>',
      author: 'Ann',
      guid: expect.stringMatching(/^ttrss:[0-9a-f]{64}$/) as string,
    });
    expect(a?.ue).toMatchObject({ unread: true, starred: false, readAt: null });
    expect(a?.ue.subscriptionId).not.toBeNull();
    const sam = await entriesOf('sam');
    expect(sam.get('A')?.entry.id).toBe(a?.entry.id);
    expect(sam.get('A')?.ue).toMatchObject({ unread: false, starred: true });
    expect(sam.get('A')?.ue.readAt?.getTime()).toBeGreaterThan(Date.now() - 6 * 60_000);
    expect(await db.select().from(entries)).toHaveLength(7);
    expect(await db.select().from(enclosures)).toEqual([
      expect.objectContaining({
        entryId: a?.entry.id,
        mimeType: 'audio/mpeg',
        durationSeconds: 62,
      }),
    ]);

    expect(pat.get('Read')?.ue).toMatchObject({ unread: false, published: true });
    expect(pat.get('Future')?.ue.sortAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(pat.get('Future')?.entry.publishedAt?.getTime()).toBeGreaterThan(Date.now());
    const archived = pat.get('Archived');
    expect(archived?.ue).toMatchObject({ subscriptionId: null, starred: true });
    const [gone] = await db
      .select()
      .from(feedSources)
      .where(eq(feedSources.id, archived?.entry.feedSourceId ?? 0));
    expect(gone?.url).toBe('https://gone.example/rss');
    const shared = pat.get('Shared');
    expect(shared?.ue).toMatchObject({ subscriptionId: null, published: true });
    const [site] = await db
      .select()
      .from(feedSources)
      .where(eq(feedSources.id, shared?.entry.feedSourceId ?? 0));
    expect(site).toMatchObject({ url: 'https://shared.example/', title: 'shared.example' });

    expect(report.tally('pat', 'entries')).toEqual({ source: 10, imported: 7 });
    expect(
      report
        .skipped('pat')
        .filter((s) => s.item !== 'feeds')
        .map((s) => [s.item, s.reason, s.count])
        .sort(),
    ).toEqual(
      [
        [
          'archived feeds',
          'archived feeds are not imported; their entries are kept without a feed',
          1,
        ],
        ['entries', 'it belongs to no feed', 1],
        ['entries', 'its feed was not imported', 1],
        ['entries', 'older than its purge age', 1],
      ].sort(),
    );
    expect(report.notes('pat')).toContainEqual(
      expect.objectContaining({
        text: '1 older than their purge age would be kept in the archive with ARCHIVE_ENABLED',
      }),
    );
  });

  describe('with the archive on', () => {
    // A copy of "Old" for sam, as TTRSS keeps one per user.
    const SAM_OLD = `
      INSERT INTO ttrss_entries (id, title, guid, link, updated, content, content_hash,
          date_entered, date_updated, author) VALUES
        (12, 'Old', 'g12', 'https://one.example/old', ${ago('100 days')}, '', 'h', ${ago('100 days')}, ${ago('100 days')}, '');
      INSERT INTO ttrss_enclosures (content_url, content_type, title, duration, width, height, post_id) VALUES
        ('https://one.example/old.mp3', 'audio/mpeg', '', '61', 0, 0, 3),
        ('https://one.example/old.mp3', 'audio/mpeg', '', '61', 0, 0, 12);
      INSERT INTO ttrss_user_entries (int_id, ref_id, uuid, feed_id, orig_feed_id, owner_uid,
          marked, published, tag_cache, label_cache, last_read, unread, note) VALUES
        (12, 12, '', 2, NULL, 3, false, false, '', '', NULL, true, NULL);`;

    beforeAll(async () => {
      await sourceDb.pool.query(SAM_OLD);
    });

    afterAll(async () => {
      await sourceDb.pool.query(`
        DELETE FROM ttrss_user_entries WHERE int_id = 12;
        DELETE FROM ttrss_enclosures WHERE post_id IN (3, 12);
        DELETE FROM ttrss_entries WHERE id = 12;`);
    });

    it('archives entries older than their purge age, copies shared by users once', async () => {
      const archive = new MemoryArchive();
      const report = await run({}, archive);
      expect(report.reconciled).toBe(true);
      expect(report.tally('pat', 'entries')).toEqual({ source: 10, imported: 7, archived: 1 });
      expect(report.tally('sam', 'entries')).toEqual({ source: 2, imported: 1, archived: 1 });
      expect(report.skipped('pat').map((s) => s.reason)).not.toContain('older than its purge age');
      expect(
        report
          .notes('pat')
          .map((n) => n.text)
          .join(),
      ).not.toContain('ARCHIVE_ENABLED');
      expect(report.format()).toMatch(/item +source +imported +archived/);

      expect(archive.rows).toHaveLength(1);
      expect(archive.rows[0]).toMatchObject({
        id: null,
        feedUrl: 'https://one.example/rss',
        guid: expect.stringMatching(/^ttrss:[0-9a-f]{64}$/) as string,
        title: 'Old',
        link: 'https://one.example/old',
        content: null,
        enclosures: [
          {
            url: 'https://one.example/old.mp3',
            mimeType: 'audio/mpeg',
            length: null,
            width: null,
            height: null,
            durationSeconds: 61,
          },
        ],
      });
      expect(archive.rows[0]?.sortAt.getTime()).toBeLessThan(Date.now() - 99 * 24 * 3600_000);
      expect((await entriesOf('pat')).has('Old')).toBe(false);
      expect(
        (await db.select().from(importMap).where(eq(importMap.sourceTable, ARCHIVED_ENTRIES)))
          .map((m) => m.sourceId)
          .sort((a, b) => a - b),
      ).toEqual([3, 12]);
    });

    it('re-runs without archiving anything again', async () => {
      const archive = new MemoryArchive();
      await run({}, archive);
      const report = await run({}, archive);
      expect(report.reconciled).toBe(true);
      expect(report.tally('pat', 'entries').archived).toBe(1);
      expect(archive.rows).toHaveLength(1);
    });

    it('counts what a dry run would archive, writing nothing', async () => {
      const archive = new MemoryArchive();
      const report = await run({ dryRun: true }, archive);
      expect(report.reconciled).toBe(true);
      expect(report.tally('pat', 'entries').archived).toBe(1);
      expect(archive.rows).toEqual([]);
      expect(await db.select().from(importMap)).toEqual([]);
    });
  });

  it('skips entries older than --since unless they are kept', async () => {
    const report = await run({ since: new Date(Date.now() - 5 * 24 * 3600_000) });
    const pat = await entriesOf('pat');
    expect(pat.has('Read')).toBe(true); // published, so kept
    expect(pat.has('Old starred')).toBe(true);
    expect(pat.has('Old noted')).toBe(true);
    expect(report.skipped('pat')).toContainEqual(
      expect.objectContaining({ reason: 'older than --since', count: 1 }),
    );
  });

  it('re-runs onto the same entries, applying state changed in TTRSS', async () => {
    await run();
    const before = (await db.select().from(userEntries)).length;
    await sourceDb.pool.query('UPDATE ttrss_user_entries SET unread = false WHERE int_id = 1');
    try {
      await run();
      expect((await db.select().from(userEntries)).length).toBe(before);
      expect((await entriesOf('pat')).get('A')?.ue.unread).toBe(false);
    } finally {
      await sourceDb.pool.query('UPDATE ttrss_user_entries SET unread = true WHERE int_id = 1');
    }
  });

  it('re-runs after imported entries were deleted here', async () => {
    await run();
    const a = (await entriesOf('pat')).get('A');
    await db.delete(userEntries).where(eq(userEntries.id, a?.ue.id ?? 0));
    // A is now older than --since, so the re-run skips it and finds its mapping stale.
    const report = await run({ since: new Date(Date.now() - 30 * 60_000) });
    expect(report.reconciled).toBe(true);
    expect((await entriesOf('pat')).has('A')).toBe(false);
    expect(
      await db
        .select()
        .from(importMap)
        .where(eq(importMap.targetId, a?.ue.id ?? 0)),
    ).toEqual([]);
  });

  it('lets the first fetch take over imported entries instead of duplicating them', async () => {
    await run();
    const a = (await entriesOf('pat')).get('A');
    const ingester = new Ingester(db, new RecordingRealtime(), {
      updateIntervalSeconds: 1800,
      purgeDays: 60,
      disableAfterFailures: 3,
    });
    const result = await ingester.ingest(a?.entry.feedSourceId ?? 0, null, [
      {
        guid: 'feed-guid-a',
        link: 'https://one.example/a',
        title: 'A',
        author: null,
        content: '<p>A, updated</p>',
        publishedAt: new Date(Date.now() - 3600_000),
        updatedAt: null,
        enclosures: [],
        categories: [],
      },
    ]);
    expect(result).toEqual({ inserted: 0, updated: 1 });
    const [entry] = await db
      .select()
      .from(entries)
      .where(eq(entries.id, a?.entry.id ?? 0));
    expect(entry).toMatchObject({ guid: 'feed-guid-a', content: '<p>A, updated</p>' });
    expect(
      (await db.select().from(userEntries)).filter((u) => u.entryId === a?.entry.id),
    ).toHaveLength(2);

    // A re-run keeps the entry the fetch took over rather than importing A again.
    const counts = async () => [
      (await db.select().from(entries)).length,
      (await db.select().from(userEntries)).length,
    ];
    const before = await counts();
    expect((await run({ force: true })).reconciled).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it('joins entries a fetch here brought in before the import reached them', async () => {
    const [one] = await db
      .insert(feedSources)
      .values({ url: 'https://one.example/rss' })
      .returning({ id: feedSources.id });
    await new Ingester(db, new RecordingRealtime(), {
      updateIntervalSeconds: 1800,
      purgeDays: 60,
      disableAfterFailures: 3,
    }).ingest(one?.id ?? 0, null, [
      {
        guid: 'feed-guid-a',
        link: 'https://one.example/a',
        title: 'A',
        author: null,
        content: '<p>A, fetched</p>',
        publishedAt: new Date(Date.now() - 3600_000),
        updatedAt: null,
        enclosures: [],
        categories: [],
      },
    ]);
    expect((await run()).reconciled).toBe(true);
    const a = (await entriesOf('pat')).get('A');
    expect(a?.entry.guid).toBe('feed-guid-a');
    expect((await entriesOf('sam')).get('A')).toMatchObject({
      entry: { id: a?.entry.id },
      ue: { unread: false, starred: true },
    });
    expect(
      (await db.select().from(entries)).filter((e) => e.link === 'https://one.example/a'),
    ).toHaveLength(1);
  });

  it('reads TTRSS durations', () => {
    expect([durationSeconds('61'), durationSeconds('1:02'), durationSeconds('1:00:01')]).toEqual([
      61, 62, 3601,
    ]);
    expect([durationSeconds(''), durationSeconds('about a minute')]).toEqual([null, null]);
  });
});
