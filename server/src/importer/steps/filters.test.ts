import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEntryServices } from '../../core/entries/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { feedSources, importMap, subscriptions, userEntries, users } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingRealtime } from '../../test/fakes.ts';
import { createTtrssSource } from '../../test/ttrss-source.ts';
import { importTtrss } from '../importer.ts';
import { TtrssSource } from '../source.ts';
import { IMPORT_STEPS } from '../steps.ts';
import { translatePattern } from './filters.ts';
import { storedFeedIds } from './full-text.ts';

let target: TestDatabase;
let sourceDb: TestDatabase;
let db: Db;

const recent = `(now() AT TIME ZONE 'UTC') - interval '1 hour'`;

/** Type and action names as TTRSS seeds them; ids are this fixture's own. */
const SOURCE_ROWS = `
  INSERT INTO ttrss_filter_types (id, name, description) VALUES
    (1, 'title', 'Title'), (2, 'content', 'Content'), (3, 'both', 'Title or content'),
    (4, 'link', 'Link'), (5, 'date', 'Article date'), (6, 'author', 'Author'), (7, 'tag', 'Tag');
  INSERT INTO ttrss_filter_actions (id, name, description) VALUES
    (1, 'filter', 'Delete'), (2, 'catchup', 'Mark read'), (3, 'mark', 'Star'), (4, 'tag', 'Tag'),
    (5, 'publish', 'Publish'), (6, 'score', 'Score'), (7, 'label', 'Label'), (8, 'stop', 'Stop'),
    (9, 'plugin', 'Plugin');
  INSERT INTO ttrss_users (id, login, pwd_hash) VALUES (2, 'pat', 'x');
  INSERT INTO ttrss_feed_categories (id, owner_uid, title) VALUES (10, 2, 'Tech');
  INSERT INTO ttrss_feeds (id, owner_uid, title, feed_url, cat_id) VALUES
    (1, 2, 'One', 'https://one.example/rss', 10), (2, 2, 'Two', 'https://two.example/rss', NULL);
  INSERT INTO ttrss_labels2 (id, owner_uid, caption) VALUES (1, 2, 'Later');
  INSERT INTO ttrss_entries (id, title, guid, link, updated, content, content_hash, date_entered, date_updated)
  VALUES (1, 'E1', 'g1', 'https://one.example/1', ${recent}, '', 'h', ${recent}, ${recent});
  INSERT INTO ttrss_user_entries (int_id, ref_id, uuid, feed_id, owner_uid, tag_cache, label_cache, score)
  VALUES (1, 1, '', 1, 2, '', '', 2000000);
  INSERT INTO ttrss_filters2 (id, owner_uid, title, enabled, match_any_rule, inverse, order_id) VALUES
    (1, 2, 'Rust', true, false, false, 1),
    (2, 2, 'Lookahead', true, false, false, 2),
    (3, 2, 'Dated', true, false, false, 3),
    (4, 2, 'Plugin', true, true, true, 4),
    (5, 2, 'Unknown label', true, false, false, 5);
  INSERT INTO ttrss_filters2_rules (filter_id, reg_exp, inverse, filter_type, match_on, feed_id, cat_id, cat_filter) VALUES
    (1, '\\bRust\\b', false, 1, '["1"]', NULL, NULL, false),
    (2, 'x(?=y)', false, 2, '["0"]', NULL, NULL, false),
    (3, '2020', false, 5, NULL, NULL, NULL, false),
    (4, 'foo\\Z', true, 4, NULL, NULL, 10, true),
    (5, 'x', false, 3, '["CAT:10", "2"]', NULL, NULL, false);
  INSERT INTO ttrss_filters2_actions (filter_id, action_id, action_param) VALUES
    (1, 3, ''), (1, 4, 'Lang, Rust Stuff'), (1, 6, '5'), (1, 7, 'later'),
    (2, 2, ''), (3, 5, ''), (4, 9, 'af_something'), (4, 1, ''), (5, 7, 'Unknown');
  INSERT INTO ttrss_plugin_storage (name, owner_uid, content) VALUES
    ('af_readability', 2, '{"enabled_feeds":[1],"append_feeds":[]}');`;

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

describe('TTRSS filters, scores, and full-text import', () => {
  it('imports filters, translating patterns and disabling those that cannot run as they did', async () => {
    const report = await run();
    expect(report.reconciled).toBe(true);
    const [pat] = await db.select().from(users).where(eq(users.login, 'pat'));
    const userId = pat?.id ?? 0;
    const services = createEntryServices(db, new RecordingRealtime());
    const imported = await services.filters.list(userId);
    const [later] = await services.labels.list(userId);
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    const one = subs.find((s) => s.title === 'One');
    expect(imported.map((f) => [f.title, f.enabled])).toEqual([
      ['Rust', true],
      ['Lookahead', false],
      ['Plugin', false],
    ]);
    expect(imported[0]).toMatchObject({
      sortOrder: 0,
      rules: [
        { field: 'title', pattern: '\\bRust\\b', subscriptionIds: [one?.id], categoryIds: [] },
      ],
      actions: [
        { type: 'star' },
        { type: 'tag', tag: 'lang' },
        { type: 'tag', tag: 'rust stuff' },
        { type: 'score', score: 5 },
        { type: 'label', labelId: later?.id },
      ],
    });
    expect(imported[2]).toMatchObject({
      matchAny: true,
      inverse: true,
      rules: [
        { field: 'link', pattern: 'foo\\z', inverse: true, categoryIds: [expect.any(Number)] },
      ],
      actions: [{ type: 'delete' }],
    });
    const notes = report.notes('pat').filter((n) => n.item === 'filters');
    expect(notes.map((n) => [n.sourceId, n.text])).toEqual([
      [2, expect.stringMatching(/^imported disabled: pattern x\(\?=y\) cannot be used/) as string],
      [4, 'imported disabled: the plugin action has no equivalent'],
    ]);
    expect(report.skipped('pat').filter((s) => s.item === 'filters')).toEqual([
      expect.objectContaining({
        sourceId: 3,
        reason: 'no rule could be imported: a date rule has no equivalent',
      }),
      expect.objectContaining({
        sourceId: 5,
        reason: 'no action could be imported: label "Unknown" was not imported',
      }),
    ]);

    // Re-runs land on the same filters.
    await run();
    expect(await services.filters.list(userId)).toHaveLength(3);
  });

  it('imports scores within the allowed range, and full-text opt-ins', async () => {
    await run();
    const [entry] = await db.select().from(userEntries);
    expect(entry?.score).toBe(1_000_000);
    const subs = await db.select().from(subscriptions);
    expect(subs.map((s) => [s.title, s.fullText]).sort()).toEqual([
      ['One', true],
      ['Two', false],
    ]);
  });

  it('translates PCRE escapes RE2 lacks, leaving escaped backslashes alone', () => {
    expect(translatePattern('a\\Z')).toBe('a\\z');
    expect(translatePattern('\\h+x\\R')).toBe('[ \\t]+x(?:\\r\\n|\\n|\\r)');
    expect(translatePattern('\\\\Z')).toBe('\\\\Z');
  });

  it('reads feed lists from JSON and PHP-serialised plugin storage', () => {
    expect(storedFeedIds('{"enabled_feeds":["12",34]}', 'enabled_feeds')).toEqual([12, 34]);
    expect(
      storedFeedIds(
        'a:2:{s:13:"enabled_feeds";a:2:{i:0;i:12;i:1;s:2:"34";}s:12:"append_feeds";a:0:{}}',
        'enabled_feeds',
      ),
    ).toEqual([12, 34]);
    expect(storedFeedIds('garbage', 'enabled_feeds')).toEqual([]);
  });
});
