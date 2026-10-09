import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../core/auth/passwords.ts';
import { createDb, type Db } from '../db/client.ts';
import {
  categories,
  feedSources,
  importMap,
  subscriptions,
  userPrefs,
  users,
} from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTtrssSource } from '../test/ttrss-source.ts';
import { type ImportOptions, importTtrss } from './importer.ts';
import { TtrssSource } from './source.ts';
import { IMPORT_STEPS } from './steps.ts';

let target: TestDatabase;
let sourceDb: TestDatabase;
let db: Db;
let adminHash = '';

const SOURCE_ROWS = `
  INSERT INTO ttrss_users (id, login, pwd_hash, access_level) VALUES
    (1, 'admin', 'x', 10), (2, 'pat', 'x', 0), (3, 'bad name!', 'x', 0);
  -- World (10) is listed before its parent News (20).
  INSERT INTO ttrss_feed_categories (id, owner_uid, title, parent_cat, order_id) VALUES
    (20, 2, 'News', NULL, 1), (10, 2, 'World', 20, 2), (30, 2, 'Tech', NULL, 3);
  INSERT INTO ttrss_feeds (id, owner_uid, title, feed_url, site_url, cat_id, update_interval,
      purge_interval, order_id, hide_images, include_in_digest, auth_login) VALUES
    (1, 2, 'One', 'https://one.example/rss', 'https://one.example/', 10, 60, -1, 5, true, true, ''),
    (2, 2, 'One again', 'HTTPS://One.Example/rss', '', NULL, 0, 0, 0, false, true, ''),
    (3, 2, 'Private', 'https://private.example/rss', '', NULL, 0, 0, 0, false, true, 'me'),
    (4, 2, 'Broken', 'not a url', '', NULL, 0, 0, 0, false, true, ''),
    (5, 2, 'Two', 'https://two.example/rss', '', NULL, -1, 7, 1, false, false, ''),
    (6, 1, 'Mine', 'https://one.example/rss', '', NULL, 5, 0, 0, false, true, '');
  INSERT INTO ttrss_user_prefs2 (owner_uid, pref_name, profile, value) VALUES
    (2, 'FRESH_ARTICLE_MAX_AGE', NULL, '48'),
    (2, 'COMBINED_DISPLAY_MODE', NULL, 'true'),
    (2, '_DEFAULT_VIEW_MODE', NULL, 'marked'),
    (2, 'USER_TIMEZONE', NULL, 'Europe/London'),
    (2, 'HIDE_READ_FEEDS', NULL, 'true');`;

async function run(changes: Partial<ImportOptions> = {}) {
  const source = await TtrssSource.open(sourceDb.url);
  try {
    return await importTtrss(
      { db, source, steps: IMPORT_STEPS, purgeDays: 60 },
      { dryRun: false, force: false, ...changes },
    );
  } finally {
    await source.close();
  }
}

const userNamed = async (login: string) =>
  (await db.select().from(users).where(eq(users.login, login)))[0];

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
  // The local administrator, who is also TTRSS's admin.
  adminHash = 'local-admin-hash';
  await db.insert(users).values({ login: 'Admin', passwordHash: adminHash, role: 'admin' });
});

afterAll(async () => {
  await sourceDb.drop();
  await target.drop();
});

describe('TTRSS import steps', () => {
  it('imports users with temporary passwords, adopting a local user with the same login', async () => {
    const report = await run();
    expect(report.reconciled).toBe(true);
    const pat = await userNamed('pat');
    expect(pat).toMatchObject({ role: 'user', passwordChangeRequired: true });
    const note = report.notes('pat').find((n) => n.item === 'users')?.text ?? '';
    const password = /temporary password (\S+)/.exec(note)?.[1] ?? '';
    expect(await verifyPassword(pat?.passwordHash ?? '', password)).toBe(true);
    expect(await userNamed('Admin')).toMatchObject({ passwordHash: adminHash, role: 'admin' });
    expect(report.notes('admin')).toContainEqual(
      expect.objectContaining({ text: 'adopted the existing user with this login' }),
    );
    expect(report.skipped('bad name!')).toEqual([
      expect.objectContaining({
        item: 'users',
        reason: expect.stringContaining('login') as string,
      }),
    ]);
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it('imports nested categories and feeds onto shared sources', async () => {
    const report = await run();
    const pat = (await userNamed('pat'))?.id ?? 0;
    const cats = await db.select().from(categories).where(eq(categories.userId, pat));
    const byTitle = new Map(cats.map((c) => [c.title, c]));
    expect(byTitle.get('World')?.parentId).toBe(byTitle.get('News')?.id);
    expect(byTitle.get('Tech')).toMatchObject({ parentId: null, sortOrder: 3 });

    const sources = await db.select().from(feedSources);
    expect(sources.map((s) => s.url).sort()).toEqual([
      'https://one.example/rss',
      'https://two.example/rss',
    ]);
    const spread = Date.now() + 31 * 60_000;
    for (const s of sources) expect(s.nextFetchAt.getTime()).toBeLessThan(spread);
    const one = sources.find((s) => s.url === 'https://one.example/rss');
    // Titled by the first feed imported (the admin's); subscriptions keep each user's title.
    expect(one).toMatchObject({ title: 'Mine', siteUrl: 'https://one.example/' });

    const subs = await db.select().from(subscriptions);
    const patSubs = subs.filter((s) => s.userId === pat);
    expect(patSubs).toHaveLength(2);
    expect(patSubs.find((s) => s.feedSourceId === one?.id)).toMatchObject({
      title: 'One',
      categoryId: byTitle.get('World')?.id,
      sortOrder: 5,
      updateIntervalSeconds: 3600,
      purgeDays: 0,
    });
    expect(patSubs.find((s) => s.feedSourceId !== one?.id)).toMatchObject({
      updateIntervalSeconds: null,
      purgeDays: 7,
    });
    // The admin's subscription shares the source, with its own title and a raised interval.
    expect(subs.find((s) => s.userId !== pat)).toMatchObject({
      feedSourceId: one?.id,
      title: 'Mine',
      updateIntervalSeconds: 15 * 60,
    });

    expect(report.tally('pat', 'feeds')).toEqual({ source: 5, imported: 2 });
    expect(
      report
        .skipped('pat')
        .filter((s) => s.item === 'feeds')
        .map((s) => [s.item, s.sourceId, s.reason]),
    ).toEqual([
      ['feeds', 2, 'same feed as 1'],
      ['feeds', 3, 'HTTP authentication is not supported yet'],
      ['feeds', 4, expect.stringContaining('not a url') as string],
    ]);
    const notes = report.notes('pat').filter((n) => n.item === 'feeds');
    expect(notes).toEqual([
      { item: 'feeds', sourceId: 1, text: 'options not imported: hide_images' },
      {
        item: 'feeds',
        sourceId: 5,
        text: 'updates were disabled in TTRSS; the feed is fetched here',
      },
      { item: 'feeds', sourceId: 5, text: 'options not imported: include_in_digest off' },
    ]);
    expect(report.notes('admin')).toContainEqual(
      expect.objectContaining({ text: 'update interval 5 min changed to 15 min' }),
    );
  });

  it('imports preferences with an equivalent, noting the rest', async () => {
    const report = await run();
    const pat = (await userNamed('pat'))?.id ?? 0;
    const prefs = await db.select().from(userPrefs).where(eq(userPrefs.userId, pat));
    expect(Object.fromEntries(prefs.map((p) => [p.key, p.value]))).toEqual({
      freshMaxAgeHours: 48,
      layout: 'combined',
      hideReadFeeds: true,
    });
    expect(report.tally('pat', 'preferences')).toEqual({ source: 4, imported: 3 });
    expect(report.skipped('pat')).toContainEqual(
      expect.objectContaining({ reason: '_DEFAULT_VIEW_MODE = "marked" has no equivalent value' }),
    );
    expect(report.notes('pat')).toContainEqual(
      expect.objectContaining({ item: 'preferences', text: 'not imported: USER_TIMEZONE' }),
    );
  });

  it('re-runs onto the rows it imported, applying source changes', async () => {
    await run();
    const count = async () => ({
      users: (await db.select().from(users)).length,
      categories: (await db.select().from(categories)).length,
      subscriptions: (await db.select().from(subscriptions)).length,
      sources: (await db.select().from(feedSources)).length,
    });
    const before = await count();
    await sourceDb.pool.query(
      "UPDATE ttrss_feed_categories SET title = 'Technology' WHERE id = 30",
    );
    await sourceDb.pool.query('UPDATE ttrss_feeds SET cat_id = 30 WHERE id = 5');
    // A fetch here followed a permanent redirect, moving the source's URL.
    await db
      .update(feedSources)
      .set({ url: 'https://two.example/feed' })
      .where(eq(feedSources.url, 'https://two.example/rss'));
    try {
      const report = await run();
      expect(report.reconciled).toBe(true);
      expect(report.notes('pat').some((n) => n.text.includes('temporary password'))).toBe(false);
      expect(await count()).toEqual(before);
      const tech = (await db.select().from(categories)).find((c) => c.title === 'Technology');
      const two = (await db.select().from(feedSources)).find((s) => s.url.includes('two'));
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.feedSourceId, two?.id ?? 0));
      expect(two?.url).toBe('https://two.example/feed');
      expect(sub?.categoryId).toBe(tech?.id);
    } finally {
      await sourceDb.pool.query("UPDATE ttrss_feed_categories SET title = 'Tech' WHERE id = 30");
      await sourceDb.pool.query('UPDATE ttrss_feeds SET cat_id = NULL WHERE id = 5');
    }
  });

  it('reports the same counts in a dry run, writing nothing', async () => {
    const dry = await run({ dryRun: true });
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(subscriptions)).toEqual([]);
    expect(dry.notes('pat')).toContainEqual(
      expect.objectContaining({ text: 'would get a temporary password' }),
    );
    const real = await run();
    for (const item of ['users', 'categories', 'feeds', 'preferences'])
      expect(dry.tally('pat', item)).toEqual(real.tally('pat', item));
  });
});
