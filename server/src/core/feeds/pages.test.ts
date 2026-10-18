import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES_SOURCE_URL, pageGuid } from './pages.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { createDb, type Db } from '../../db/client.ts';
import { migrationsFolder } from '../../db/migrate.ts';
import {
  enclosures,
  entries,
  entryLabels,
  entryTags,
  feedSources,
  importMap,
  labels,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';

let database: TestDatabase;
let db: Db;

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

/** Runs the migration again, in one transaction as the migrator does. */
async function migrate() {
  const text = await readFile(join(migrationsFolder, '0032_pages_source.sql'), 'utf8');
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of text.split('--> statement-breakpoint')) await client.query(statement);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const user = async (login: string) =>
  first(await db.insert(users).values({ login, passwordHash: 'x' }).returning()).id;

const source = async (url: string) =>
  first(await db.insert(feedSources).values({ url, title: 'site' }).returning()).id;

const entry = async (feedSourceId: number, guid: string, link: string) =>
  first(
    await db
      .insert(entries)
      .values({
        feedSourceId,
        guid,
        link,
        title: guid,
        content: `<p>${guid}</p>`,
        contentHash: guid,
      })
      .returning(),
  ).id;

const hold = async (
  userId: number,
  entryId: number,
  state: Partial<typeof userEntries.$inferInsert> = {},
) =>
  first(
    await db
      .insert(userEntries)
      .values({ userId, entryId, sortAt: new Date(), ...state })
      .returning(),
  ).id;

const userEntry = async (id: number) =>
  (await db.select().from(userEntries).where(eq(userEntries.id, id)))[0];

const entryOf = async (userEntryId: number) =>
  first(
    await db
      .select({ entry: entries, url: feedSources.url })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
      .innerJoin(feedSources, eq(feedSources.id, entries.feedSourceId))
      .where(eq(userEntries.id, userEntryId)),
  );

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

afterAll(async () => {
  await database.drop();
});

describe('pages source migration', () => {
  it('moves imported pages out of site sources, one entry per holder', async () => {
    expect(first(await db.select().from(feedSources)).url).toBe(PAGES_SOURCE_URL);
    const [pat, sam, kim] = [await user('pat'), await user('sam'), await user('kim')];

    // pat published a page, sam starred it; kim subscribed to the site's address and received it.
    const site = await source('https://shared.example/');
    const kimSub = first(
      await db.insert(subscriptions).values({ userId: kim, feedSourceId: site }).returning(),
    ).id;
    const post1 = await entry(site, 'ttrss:1', 'https://shared.example/post/1#top');
    await db.insert(enclosures).values({ entryId: post1, url: 'https://shared.example/a.mp3' });
    const patPost1 = await hold(pat, post1, { published: true, note: 'mine' });
    const label = first(
      await db
        .insert(labels)
        .values({ userId: pat, caption: 'L', fgColor: '#000000', bgColor: '#ffffff' })
        .returning(),
    ).id;
    await db.insert(entryLabels).values({ userEntryId: patPost1, labelId: label });
    await db.insert(entryTags).values({ userEntryId: patPost1, userId: pat, tag: 'news' });
    const samPost1 = await hold(sam, post1, { starred: true });
    const kimPost1 = await hold(kim, post1, { subscriptionId: kimSub });
    // kim starred another page they received.
    const post2 = await entry(site, 'ttrss:2', 'https://shared.example/post/2');
    const patPost2 = await hold(pat, post2, { published: true });
    const kimPost2 = await hold(kim, post2, { subscriptionId: kimSub, starred: true });

    // An imported feed at a site's address, and an archived feed, stay as they are.
    const real = await source('https://real.example/');
    const realSub = first(
      await db.insert(subscriptions).values({ userId: sam, feedSourceId: real }).returning(),
    ).id;
    await db
      .insert(importMap)
      .values({ sourceTable: 'ttrss_feeds', sourceId: 1, targetId: realSub, userId: sam });
    const realEntry = await entry(real, 'ttrss:3', 'https://real.example/a');
    const patReal = await hold(pat, realEntry, { starred: true });
    const gone = await source('https://gone.example/rss');
    const goneEntry = await entry(gone, 'ttrss:4', 'https://gone.example/a');
    const patGone = await hold(pat, goneEntry, { starred: true });

    await migrate();

    const page = await entryOf(patPost1);
    expect(page.url).toBe(PAGES_SOURCE_URL);
    expect(page.entry).toMatchObject({
      guid: pageGuid(pat, 'https://shared.example/post/1'),
      link: 'https://shared.example/post/1#top',
      content: '<p>ttrss:1</p>',
      contentHash: 'ttrss:1',
    });
    expect(await userEntry(patPost1)).toMatchObject({ published: true, note: 'mine' });
    expect(await db.select().from(entryLabels)).toEqual([
      expect.objectContaining({ userEntryId: patPost1 }),
    ]);
    expect(await db.select().from(entryTags)).toEqual([
      expect.objectContaining({ userEntryId: patPost1, tag: 'news' }),
    ]);
    expect(
      await db.select().from(enclosures).where(eq(enclosures.entryId, page.entry.id)),
    ).toHaveLength(1);

    const samPage = await entryOf(samPost1);
    expect(samPage.entry.guid).toBe(pageGuid(sam, 'https://shared.example/post/1'));
    expect(await userEntry(samPost1)).toMatchObject({ starred: true, subscriptionId: null });
    expect(await userEntry(kimPost1)).toBeUndefined();
    expect((await entryOf(kimPost2)).entry.guid).toBe(
      pageGuid(kim, 'https://shared.example/post/2'),
    );
    expect(await userEntry(kimPost2)).toMatchObject({ starred: true, subscriptionId: null });
    expect((await entryOf(patPost2)).entry.guid).toBe(
      pageGuid(pat, 'https://shared.example/post/2'),
    );
    expect(await db.select().from(entries).where(eq(entries.feedSourceId, site))).toEqual([]);

    expect((await entryOf(patReal)).entry.id).toBe(realEntry);
    expect((await entryOf(patGone)).entry.id).toBe(goneEntry);

    const before = await db.select().from(entries);
    await migrate();
    expect(await db.select().from(entries)).toEqual(before);
  });
});
