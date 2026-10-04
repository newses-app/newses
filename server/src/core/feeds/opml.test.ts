import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { createFeedServices, type FeedServices } from './index.ts';

let database: TestDatabase;
let db: Db;
let services: FeedServices;
let alice: number;
let bob: number;

// Shape of a Tiny Tiny RSS export: nested categories, root feeds, and TTRSS-only sections.
const TTRSS_EXPORT = `<?xml version="1.0" encoding="utf-8"?>
<opml version="1.0">
  <head><dateCreated>Sat, 03 Oct 2026 12:00:00 +0000</dateCreated><title>Tiny Tiny RSS Feed Export</title></head>
  <body>
    <outline text="Tech">
      <outline text="Dev">
        <outline type="rss" text="Node releases" xmlUrl="https://github.com/nodejs/node/releases.atom" htmlUrl="https://github.com/nodejs/node"/>
      </outline>
      <outline type="rss" text="LWN" xmlUrl="https://lwn.net/headlines/rss"/>
      <outline text="Empty"/>
    </outline>
    <outline type="rss" text="xkcd &amp; friends" xmlUrl="https://xkcd.com/atom.xml" htmlUrl="https://xkcd.com/"/>
    <outline type="rss" text="Broken" xmlUrl="gopher://nope"/>
    <outline text="tt-rss-prefs" schema-version="150"><outline pref-name="PURGE_OLD_DAYS" value="60"/></outline>
    <outline text="tt-rss-labels" schema-version="150"><outline label-name="Important" label-fg-color="#fff"/></outline>
  </body>
</opml>`;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createFeedServices(db, new FakeFetcher());
});

beforeEach(async () => {
  await db.delete(users);
  const created = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  alice = created[0]?.id ?? 0;
  bob = created[1]?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

async function tree(userId: number) {
  const categories = await services.categories.list(userId);
  const subs = await services.subscriptions.list(userId);
  const path = (id: number | null): string => {
    const c = categories.find((x) => x.id === id);
    return c ? `${path(c.parentId)}/${c.title}` : '';
  };
  return {
    categories: categories.map((c) => path(c.id)).sort(),
    feeds: subs
      .map(({ subscription, source }) => `${path(subscription.categoryId)} ${source.url}`)
      .sort(),
  };
}

describe('OpmlService', () => {
  it('imports a TTRSS export with nested categories', async () => {
    expect(await services.opml.import(alice, TTRSS_EXPORT)).toEqual({
      categoriesCreated: 3,
      subscribed: 3,
      alreadySubscribed: 0,
      invalid: [{ url: 'gopher://nope', reason: 'Only http and https URLs are supported' }],
    });
    expect(await tree(alice)).toEqual({
      categories: ['/Tech', '/Tech/Dev', '/Tech/Empty'],
      feeds: [
        ' https://xkcd.com/atom.xml',
        '/Tech https://lwn.net/headlines/rss',
        '/Tech/Dev https://github.com/nodejs/node/releases.atom',
      ],
    });
    const [xkcd] = (await services.subscriptions.list(alice)).filter((s) =>
      s.source.url.includes('xkcd'),
    );
    expect(xkcd?.source).toMatchObject({ title: 'xkcd & friends', siteUrl: 'https://xkcd.com/' });
  });

  it('is idempotent', async () => {
    await services.opml.import(alice, TTRSS_EXPORT);
    expect(await services.opml.import(alice, TTRSS_EXPORT)).toMatchObject({
      categoriesCreated: 0,
      subscribed: 0,
      alreadySubscribed: 3,
    });
  });

  it('round-trips through export', async () => {
    await services.opml.import(alice, TTRSS_EXPORT);
    const exported = await services.opml.export(alice);
    expect(exported).toContain('<opml');
    await services.opml.import(bob, exported);
    expect(await tree(bob)).toEqual(await tree(alice));
  });

  it('rejects documents that are not OPML', async () => {
    await expect(services.opml.import(alice, '<rss version="2.0"/>')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
