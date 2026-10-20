import {
  MAX_CATEGORY_TITLE_LENGTH,
  MAX_FEED_TITLE_LENGTH,
  MAX_FEED_URL_LENGTH,
  MAX_LABEL_CAPTION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PAGE_URL_LENGTH,
  MAX_SUBSCRIPTION_TITLE_LENGTH,
} from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { userEntries } from '../db/schema.ts';
import { reader, readerLogin, ttrss, ttrssLogin } from '../test/compat.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

// Limits hold where data is written, whichever API it comes through.

const FEED = 'https://news.example/rss';
const long = (length: number) => 'x'.repeat(length + 1);
const longUrl = (length: number) => `https://long.example/${long(length)}`;

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
const fetcher = new FakeFetcher().set(FEED, {
  body: rss('News', 'https://news.example/', [
    { guid: 'a', title: 'A', link: 'https://news.example/a' },
  ]),
});
let pat = 0;
let subscriptionId = 0;
let entryId = 0;
let sid = '';
let auth = '';

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher);
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  pat = (await services.users.create('pat', 'pat password')).id;
  const subscribed = await services.feeds.subscriptions.subscribe(pat, FEED);
  if (subscribed.status !== 'subscribed') throw new Error('not subscribed');
  subscriptionId = subscribed.subscription.subscription.id;
  const [entry] = await db.select({ id: userEntries.id }).from(userEntries);
  entryId = entry?.id ?? 0;
  const { password } = await services.appPasswords.create(pat, 'Phone');
  sid = await ttrssLogin(app, 'pat', password);
  auth = await readerLogin(app, 'pat', password);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const invalid = { code: 'invalid_input' };

describe('length limits', () => {
  it('are enforced by the services', async () => {
    const { categories, subscriptions, publishedPages } = services.feeds;
    const category = await categories.create(pat, 'Tech');
    await expect(categories.create(pat, long(MAX_CATEGORY_TITLE_LENGTH))).rejects.toMatchObject(
      invalid,
    );
    await expect(
      categories.update(pat, category.id, { title: long(MAX_CATEGORY_TITLE_LENGTH) }),
    ).rejects.toMatchObject(invalid);
    const labels = services.entries.labels;
    const caption = long(MAX_LABEL_CAPTION_LENGTH);
    await expect(
      labels.create(pat, { caption, fgColor: '#000000', bgColor: '#ffffff' }),
    ).rejects.toMatchObject(invalid);
    await expect(
      subscriptions.update(pat, subscriptionId, { title: long(MAX_SUBSCRIPTION_TITLE_LENGTH) }),
    ).rejects.toMatchObject(invalid);
    const requested = fetcher.requested.length;
    await expect(subscriptions.subscribe(pat, longUrl(MAX_FEED_URL_LENGTH))).rejects.toMatchObject(
      invalid,
    );
    await expect(
      services.entries.entries.setNote(pat, entryId, long(MAX_NOTE_LENGTH)),
    ).rejects.toMatchObject(invalid);
    await expect(
      publishedPages.publish(pat, { url: longUrl(MAX_PAGE_URL_LENGTH) }),
    ).rejects.toMatchObject(invalid);
    expect(fetcher.requested).toHaveLength(requested);
  });

  it('refuse over-long names and addresses from Google Reader clients', async () => {
    const api = (path: string, form: Record<string, string>) =>
      reader(app, 'POST', `/reader/api/0/${path}`, { token: auth, form });
    const label = await api('edit-tag', {
      i: String(entryId),
      a: `user/-/label/${long(MAX_LABEL_CAPTION_LENGTH)}`,
    });
    expect(label.statusCode).toBe(400);
    expect(
      (
        await api('subscription/edit', {
          ac: 'edit',
          s: `feed/${String(subscriptionId)}`,
          t: long(MAX_SUBSCRIPTION_TITLE_LENGTH),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await api('rename-tag', { s: 'user/-/label/Tech', dest: `user/-/label/${long(200)}` }))
        .statusCode,
    ).toBe(400);
    const added = await api('subscription/quickadd', { quickadd: longUrl(MAX_FEED_URL_LENGTH) });
    expect(added.json()).toMatchObject({ numResults: 0 });
  });

  it('refuse over-long input from TTRSS clients', async () => {
    const call = (op: string, params: Record<string, unknown>) =>
      ttrss(app, { op, sid, ...params });
    expect(await call('subscribeToFeed', { feed_url: longUrl(MAX_FEED_URL_LENGTH) })).toMatchObject(
      { status: 0, content: { status: { code: 2 } } },
    );
    expect(
      await call('updateArticle', {
        article_ids: String(entryId),
        field: 3,
        data: long(MAX_NOTE_LENGTH),
      }),
    ).toMatchObject({ status: 1, content: { error: 'INCORRECT_USAGE' } });
    expect(
      await call('shareToPublished', {
        url: longUrl(MAX_PAGE_URL_LENGTH),
        title: 'T',
        content: 'C',
      }),
    ).toMatchObject({ status: 1 });
  });

  it('cut over-long names in OPML imports and list over-long addresses as invalid', async () => {
    const name = 'y'.repeat(MAX_CATEGORY_TITLE_LENGTH + 50);
    const title = 'z'.repeat(MAX_FEED_TITLE_LENGTH + 50);
    const url = longUrl(MAX_FEED_URL_LENGTH);
    const result = await services.feeds.opml.import(
      pat,
      `<?xml version="1.0"?><opml version="2.0"><head/><body><outline text="${name}"><outline text="${title}" xmlUrl="https://titled.example/rss"/></outline><outline text="Long" xmlUrl="${url}"/></body></opml>`,
    );
    expect(result).toMatchObject({ categoriesCreated: 1, subscribed: 1 });
    expect(result.invalid).toEqual([
      { url: url.slice(0, MAX_FEED_URL_LENGTH), reason: expect.any(String) as string },
    ]);
    const categories = await services.feeds.categories.list(pat);
    expect(categories.find((c) => c.title.startsWith('y'))?.title).toHaveLength(
      MAX_CATEGORY_TITLE_LENGTH,
    );
    const subscriptions = await services.feeds.subscriptions.list(pat);
    const titled = subscriptions.find((s) => s.source.url === 'https://titled.example/rss');
    expect(titled?.source.title).toHaveLength(MAX_FEED_TITLE_LENGTH);
  });
});
