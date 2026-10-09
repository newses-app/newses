import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  accessKeys,
  entries,
  entryLabels,
  entryTags,
  feedSources,
  importMap,
  labels,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { createTtrssSource } from '../../test/ttrss-source.ts';
import { importTtrss } from '../importer.ts';
import { TtrssSource } from '../source.ts';
import { IMPORT_STEPS } from '../steps.ts';
import { hexColour } from './labels.ts';
import { stableUuid } from './sharing.ts';

let target: TestDatabase;
let sourceDb: TestDatabase;
let db: Db;

const SHARE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const LONG_TAG = 'x'.repeat(70);
const recent = `(now() AT TIME ZONE 'UTC') - interval '1 hour'`;
const old = `(now() AT TIME ZONE 'UTC') - interval '100 days'`;

/** pat has four entries; the fourth is past the purge age and not kept, so it is not imported. */
const SOURCE_ROWS = `
  INSERT INTO ttrss_users (id, login, pwd_hash) VALUES (2, 'pat', 'x');
  INSERT INTO ttrss_feeds (id, owner_uid, title, feed_url) VALUES (1, 2, 'One', 'https://one.example/rss');
  INSERT INTO ttrss_entries (id, title, guid, link, updated, content, content_hash, date_entered, date_updated)
  VALUES
    (1, 'E1', 'g1', 'https://one.example/1', ${recent}, '', 'h', ${recent}, ${recent}),
    (2, 'E2', 'g2', 'https://one.example/2', ${recent}, '', 'h', ${recent}, ${recent}),
    (3, 'E3', 'g3', 'https://one.example/3', ${recent}, '', 'h', ${recent}, ${recent}),
    (4, 'E4', 'g4', 'https://one.example/4', ${old}, '', 'h', ${old}, ${old});
  INSERT INTO ttrss_user_entries (int_id, ref_id, uuid, feed_id, owner_uid, tag_cache, label_cache, note)
  VALUES
    (1, 1, '${SHARE.toUpperCase()}', 1, 2, '', '', 'remember'),
    (2, 2, 'abc123', 1, 2, '', '', NULL),
    (3, 3, '', 1, 2, '', '', repeat('n', 10050)),
    (4, 4, '', 1, 2, '', '', NULL);
  INSERT INTO ttrss_labels2 (id, owner_uid, caption, fg_color, bg_color) VALUES
    (1, 2, 'Later', '#FFF', '#B00020'), (2, 2, 'later', '', ''),
    (3, 2, 'Red', 'red', 'blue'), (4, 2, '   ', '', '');
  INSERT INTO ttrss_user_labels2 (label_id, article_id) VALUES (1, 1), (2, 1), (3, 2);
  INSERT INTO ttrss_tags (tag_name, owner_uid, post_int_id) VALUES
    ('Open Source', 2, 1), ('open source', 2, 1), (',', 2, 1), ('${LONG_TAG}', 2, 1), ('x', 2, 4);
  INSERT INTO ttrss_tags (tag_name, owner_uid, post_int_id)
    SELECT 't' || g, 2, 2 FROM generate_series(1, 55) g;
  INSERT INTO ttrss_access_keys (access_key, feed_id, is_cat, owner_uid) VALUES
    ('k-published_1', '-2', false, 2), ('other', '5', false, 2), ('cat', '3', true, 2);`;

async function run() {
  const source = await TtrssSource.open(sourceDb.url);
  try {
    return await importTtrss(
      { db, source, steps: IMPORT_STEPS, purgeDays: 60 },
      { dryRun: false, force: false },
    );
  } finally {
    await source.close();
  }
}

/** pat's entries by title. */
async function entriesByTitle() {
  const rows = await db
    .select({ title: entries.title, ue: userEntries })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId));
  return new Map(rows.map((r) => [r.title ?? '', r.ue]));
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

describe('TTRSS labels, tags, notes, and sharing import', () => {
  it('imports labels with hex colours, merging captions equal ignoring case', async () => {
    const report = await run();
    expect(report.reconciled).toBe(true);
    const imported = await db.select().from(labels);
    expect(imported.map((l) => [l.caption, l.fgColor, l.bgColor]).sort()).toEqual([
      ['Later', '#ffffff', '#b00020'],
      ['Red', '#ffffff', '#1565c0'],
    ]);
    const byTitle = await entriesByTitle();
    const assigned = await db.select().from(entryLabels);
    const later = imported.find((l) => l.caption === 'Later')?.id;
    const red = imported.find((l) => l.caption === 'Red')?.id;
    expect(assigned.map((a) => [a.userEntryId, a.labelId]).sort()).toEqual(
      [
        [byTitle.get('E1')?.id, later],
        [byTitle.get('E2')?.id, red],
      ].sort(),
    );
    expect(report.tally('pat', 'label assignments')).toEqual({ source: 3, imported: 2 });
    expect(report.notes('pat').map((n) => n.text)).toEqual(
      expect.arrayContaining([
        'merged with a label whose caption differs only in case',
        'colours red/blue replaced',
      ]),
    );
    expect(report.skipped('pat')).toContainEqual(
      expect.objectContaining({ item: 'labels', reason: 'empty caption' }),
    );
  });

  it('imports tags normalised, at most 50 per entry', async () => {
    const report = await run();
    const byTitle = await entriesByTitle();
    const tags = await db.select().from(entryTags);
    const of = (title: string) =>
      tags
        .filter((t) => t.userEntryId === byTitle.get(title)?.id)
        .map((t) => t.tag)
        .sort();
    expect(of('E1')).toEqual(['open source', 'x'.repeat(64)]);
    expect(of('E2')).toHaveLength(50);
    expect(report.tally('pat', 'tags')).toEqual({ source: 60, imported: 52 });
    expect(
      report
        .skipped('pat')
        .filter((s) => s.item === 'tags')
        .map((s) => [s.reason, s.count]),
    ).toEqual([
      ['its entry was not imported', 1],
      ['empty once normalised', 1],
      ['duplicate once normalised', 1],
      ['over 50 on one entry', 5],
    ]);
  });

  it('imports notes, share links, and the published feed key', async () => {
    const report = await run();
    const byTitle = await entriesByTitle();
    expect(byTitle.get('E1')).toMatchObject({ note: 'remember', shareId: SHARE });
    expect(byTitle.get('E2')?.shareId).toBe(stableUuid('ttrss share 2 abc123'));
    expect(byTitle.get('E3')?.note).toHaveLength(10_000);
    expect(report.notes('pat').map((n) => [n.item, n.text])).toEqual(
      expect.arrayContaining([
        ['notes', 'shortened to 10000 characters'],
        ['share links', 'given a new link; the old one stops working'],
      ]),
    );
    expect(
      await db.select({ key: accessKeys.key, purpose: accessKeys.purpose }).from(accessKeys),
    ).toEqual([{ key: 'k-published_1', purpose: 'published' }]);
    expect(report.tally('pat', 'access keys')).toEqual({ source: 3, imported: 1 });
  });

  it('re-runs to the same links, applying removals made in TTRSS', async () => {
    await run();
    const first = await entriesByTitle();
    await sourceDb.pool.query(
      'DELETE FROM ttrss_user_labels2 WHERE label_id = 3; UPDATE ttrss_user_entries SET note = NULL WHERE int_id = 1; DELETE FROM ttrss_tags WHERE post_int_id = 1',
    );
    try {
      expect((await run()).reconciled).toBe(true);
      const second = await entriesByTitle();
      expect(second.get('E2')?.shareId).toBe(first.get('E2')?.shareId);
      expect(second.get('E1')).toMatchObject({ note: null, shareId: SHARE });
      const assigned = await db.select().from(entryLabels);
      expect(assigned.map((a) => a.userEntryId)).toEqual([second.get('E1')?.id]);
      const tags = await db.select().from(entryTags);
      expect(tags.filter((t) => t.userEntryId === second.get('E1')?.id)).toEqual([]);
    } finally {
      await sourceDb.pool.query(`
        INSERT INTO ttrss_user_labels2 (label_id, article_id) VALUES (3, 2);
        UPDATE ttrss_user_entries SET note = 'remember' WHERE int_id = 1;
        INSERT INTO ttrss_tags (tag_name, owner_uid, post_int_id) VALUES
          ('Open Source', 2, 1), ('open source', 2, 1), (',', 2, 1), ('${LONG_TAG}', 2, 1);`);
    }
  });

  it('normalises TTRSS colours', () => {
    expect(['#ABC', 'aabbcc', ' #A1B2C3 ', 'red', ''].map(hexColour)).toEqual([
      '#aabbcc',
      '#aabbcc',
      '#a1b2c3',
      null,
      null,
    ]);
  });
});
