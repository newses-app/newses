import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { testFeedDeps } from '../../test/fakes.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MAX_OPML_DEPTH, MAX_OPML_OUTLINES } from '@newses/shared';
import { ThrottledError } from '../errors.ts';
import { RATE_LIMITS } from '../rate-limit.ts';
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
  services = createFeedServices(testFeedDeps(db, new FakeFetcher()));
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

  it('imports a file at the limit in one go, the first outline of a feed naming it', async () => {
    // 50 folders of 39 feeds: 2,000 outlines; folder 1 repeats a feed of folder 0.
    const folders = Array.from({ length: 50 }, (_, f) =>
      folder(
        `Folder ${String(f)}`,
        Array.from({ length: 39 }, (_, n) =>
          feed(`https://f${String(f)}.example/${String(n)}`, `Feed ${String(f)}.${String(n)}`),
        ).join(''),
      ),
    );
    folders[1] = folder(
      'Folder 1',
      `${feed('https://f0.example/0', 'Again')}${Array.from({ length: 38 }, (_, n) =>
        feed(`https://f1.example/${String(n)}`, 'x'),
      ).join('')}`,
    );
    const started = Date.now();
    expect(await services.opml.import(alice, opml(folders.join('')))).toEqual({
      categoriesCreated: 50,
      subscribed: 1949,
      alreadySubscribed: 1,
      invalid: [],
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const [first] = (await services.subscriptions.list(alice)).filter(
      (s) => s.source.url === 'https://f0.example/0',
    );
    expect(first?.source.title).toBe('Feed 0.0');
  });

  it('refuses files over the limits before writing anything', async () => {
    const many = Array.from({ length: MAX_OPML_OUTLINES + 1 }, (_, n) =>
      feed(`https://many.example/${String(n)}`, 'x'),
    ).join('');
    await expect(services.opml.import(alice, opml(many))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    let deep = feed('https://deep.example/', 'Deep');
    for (let n = 0; n < MAX_OPML_DEPTH; n++) deep = folder(`Level ${String(n)}`, deep);
    await expect(services.opml.import(alice, opml(deep))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await tree(alice)).toEqual({ categories: [], feeds: [] });
  });

  it('limits how often a user imports', async () => {
    for (let n = 0; n < RATE_LIMITS.import; n++) await services.opml.import(bob, TTRSS_EXPORT);
    await expect(services.opml.import(bob, TTRSS_EXPORT)).rejects.toBeInstanceOf(ThrottledError);
  });
});

const feed = (url: string, title: string) =>
  `<outline type="rss" text="${title}" xmlUrl="${url}"/>`;
const folder = (title: string, children: string) =>
  `<outline text="${title}">${children}</outline>`;
const opml = (body: string) =>
  `<?xml version="1.0"?><opml version="2.0"><head/><body>${body}</body></opml>`;
