// Contract tests for the TTRSS-compatible API: requests as TTRSS clients send them, checked
// against the response shapes in the public API reference (ADR 0009).
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FetchError } from '../core/feeds/http.ts';
import { createDb, type Db } from '../db/client.ts';
import {
  categories,
  enclosures,
  entries,
  feedSources,
  subscriptions,
  userEntries,
  users,
} from '../db/schema.ts';
import { ttrss, ttrssLogin } from '../test/compat.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, htmlPage, rss } from '../test/fake-fetcher.ts';
import { MemoryBlobStore } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
const fetcher = new FakeFetcher();
const blobs = new MemoryBlobStore();
const logs: Record<string, unknown>[] = [];
let pat = 0;
let sid = '';
let ids: Record<string, number> = {};
let subs: Record<string, number> = {};
let cats: Record<string, number> = {};
let label = 0;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher, { blobs });
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  app = buildApp({ logger, healthChecks: {}, services });
  await app.ready();
});

/** pat: Tech › Web categories, an empty category, three feeds, five entries, one label. */
beforeEach(async () => {
  logs.length = 0;
  await db.delete(users);
  await db.delete(feedSources);
  pat = (await services.users.create('pat', 'pat password')).id;
  const bob = (await services.users.create('bob', 'bob password')).id;
  const [tech] = await db.insert(categories).values({ userId: pat, title: 'Tech' }).returning();
  const [web] = await db
    .insert(categories)
    .values({ userId: pat, title: 'Web', parentId: tech?.id ?? null })
    .returning();
  const [empty] = await db.insert(categories).values({ userId: pat, title: 'Empty' }).returning();
  cats = { tech: tech?.id ?? 0, web: web?.id ?? 0, empty: empty?.id ?? 0 };
  const sources = await db
    .insert(feedSources)
    .values([
      { url: 'https://one.example/rss', title: 'One', faviconKey: 'favicons/one' },
      { url: 'https://two.example/rss', title: 'Two' },
      { url: 'https://three.example/rss', title: 'Three', lastError: 'HTTP 500' },
    ])
    .returning();
  await blobs.put('favicons/one', { data: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
  const subRows = await db
    .insert(subscriptions)
    .values([
      { userId: pat, feedSourceId: sources[0]?.id ?? 0, categoryId: cats.tech ?? null },
      { userId: pat, feedSourceId: sources[1]?.id ?? 0, categoryId: cats.web ?? null },
      { userId: pat, feedSourceId: sources[2]?.id ?? 0 },
      { userId: bob, feedSourceId: sources[0]?.id ?? 0 },
    ])
    .returning();
  subs = { one: subRows[0]?.id ?? 0, two: subRows[1]?.id ?? 0, three: subRows[2]?.id ?? 0 };
  subs.bob = subRows[3]?.id ?? 0;
  const spec = [
    {
      key: 'apple',
      source: 0,
      sub: subs.one,
      hours: 1,
      content: '<p>Apple <img src="https://img.example/a.png"></p>',
    },
    { key: 'banana', source: 0, sub: subs.one, hours: 30, content: '<p>Banana</p>' },
    { key: 'cherry', source: 1, sub: subs.two, hours: 2, content: '<p>Cherry</p>' },
    { key: 'date', source: 2, sub: subs.three, hours: 48, content: '<p>Date</p>' },
    { key: 'elder', source: 2, sub: subs.three, hours: 72, content: '<p>Elder</p>' },
  ];
  ids = {};
  for (const s of spec) {
    const [entry] = await db
      .insert(entries)
      .values({
        feedSourceId: sources[s.source]?.id ?? 0,
        guid: s.key,
        title: s.key,
        link: `https://example/${s.key}`,
        author: 'Ann',
        content: s.content,
        contentHash: s.key,
        publishedAt: hoursAgo(s.hours),
      })
      .returning();
    const [ue] = await db
      .insert(userEntries)
      .values({
        userId: pat,
        entryId: entry?.id ?? 0,
        subscriptionId: s.sub ?? null,
        sortAt: hoursAgo(s.hours),
      })
      .returning();
    ids[s.key] = ue?.id ?? 0;
    if (s.key === 'apple')
      await db.insert(enclosures).values({
        entryId: entry?.id ?? 0,
        url: 'https://example/a.mp3',
        mimeType: 'audio/mpeg',
        durationSeconds: 60,
      });
  }
  label = (
    await services.entries.labels.create(pat, {
      caption: 'Later',
      fgColor: '#ffffff',
      bgColor: '#b00020',
    })
  ).id;
  await services.entries.labels.setEntryLabels(pat, ids.cherry ?? 0, [label]);
  await services.entries.tags.setEntryTags(pat, ids.date ?? 0, ['recipes']);
  const { password } = await services.appPasswords.create(pat, 'Phone');
  sid = await ttrssLogin(app, 'pat', password);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const call = async <T = unknown>(op: string, params: Record<string, unknown> = {}) => {
  const response = await ttrss<T>(app, { op, sid, ...params });
  if (response.status !== 0) throw new Error(`${op} failed: ${JSON.stringify(response.content)}`);
  return response.content;
};
const titles = (list: { title: string }[]) => list.map((h) => h.title);
const labelFeed = () => -1025 - label;

describe('TTRSS config and tree', () => {
  it('returns config at login and from getConfig, with signed icon URLs', async () => {
    const { password } = await services.appPasswords.create(pat, 'Tablet');
    const login = await ttrss<{ config: Record<string, unknown> }>(app, {
      op: 'login',
      user: 'pat',
      password,
    });
    const config = await call<{ icons_url: string }>('getConfig');
    expect(login.content.config).toEqual(config);
    expect(config).toMatchObject({
      icons_dir: 'feed-icons',
      daemon_is_running: true,
      num_feeds: 3,
    });

    const icon = await app.inject({
      method: 'GET',
      url: `/${config.icons_url}/${String(subs.one)}.ico`,
    });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    for (const url of [
      `/${config.icons_url}/${String(subs.two)}.ico`,
      `/${config.icons_url}/${String(subs.bob)}.ico`,
      `/feed-icons/${String(pat)}.forged/${String(subs.one)}.ico`,
    ])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('lists feeds by category id, with special and label feeds', async () => {
    type Feed = { id: number; title: string; unread: number; cat_id: number; has_icon?: boolean };
    expect(await call<Feed[]>('getFeeds', { cat_id: cats.tech })).toEqual([
      expect.objectContaining({
        id: subs.one,
        title: 'One',
        feed_url: 'https://one.example/rss',
        unread: 2,
        has_icon: true,
        cat_id: cats.tech,
      }),
    ]);
    const nested = await call<Feed[]>('getFeeds', { cat_id: cats.tech, include_nested: true });
    expect(nested[0]).toMatchObject({ id: cats.web, title: 'Web', is_cat: true, unread: 1 });
    expect(titles(await call<Feed[]>('getFeeds', { cat_id: 0 }))).toEqual(['Three']);
    expect(await call<Feed[]>('getFeeds', { cat_id: -1 })).toContainEqual({
      id: -4,
      title: 'All articles',
      unread: 5,
      cat_id: -1,
    });
    expect(await call<Feed[]>('getFeeds', { cat_id: -2 })).toEqual([
      { id: labelFeed(), title: 'Later', unread: 1, cat_id: -2 },
    ]);
    const all = await call<Feed[]>('getFeeds', { cat_id: -4 });
    expect(all).toHaveLength(6 + 1 + 3);
    expect(await call<Feed[]>('getFeeds', { cat_id: -3, limit: 1, offset: 1 })).toHaveLength(1);
    await call('catchupFeed', { feed_id: subs.three });
    expect(titles(await call<Feed[]>('getFeeds', { cat_id: -3, unread_only: true }))).toEqual([
      'One',
      'Two',
    ]);
  });

  it('lists categories flat or nested, with Uncategorized, Special, and Labels', async () => {
    type Category = { id: number; title: string; unread: number };
    expect(await call<Category[]>('getCategories')).toEqual([
      expect.objectContaining({ id: cats.tech, title: 'Tech', unread: 3 }),
      expect.objectContaining({ id: cats.web, title: 'Web', unread: 1 }),
      expect.objectContaining({ id: 0, title: 'Uncategorized', unread: 2 }),
      expect.objectContaining({ id: -1, title: 'Special' }),
      expect.objectContaining({ id: -2, title: 'Labels', unread: 1 }),
    ]);
    const nested = await call<Category[]>('getCategories', {
      enable_nested: true,
      include_empty: true,
    });
    expect(titles(nested)).toEqual(['Empty', 'Tech', 'Uncategorized', 'Special', 'Labels']);
  });

  it('returns the feed tree in the dojo store shape', async () => {
    const { categories: tree } = await call<{
      categories: { identifier: string; label: string; items: Record<string, unknown>[] };
    }>('getFeedTree');
    expect(tree).toMatchObject({ identifier: 'id', label: 'name' });
    expect(tree.items.map((item) => item.id)).toEqual([
      'CAT:-1',
      'CAT:-2',
      `CAT:${String(cats.tech)}`,
      'CAT:0',
    ]);
    expect(tree.items[2]).toMatchObject({
      bare_id: cats.tech,
      name: 'Tech',
      type: 'category',
      items: [
        {
          id: `CAT:${String(cats.web)}`,
          items: [{ id: `FEED:${String(subs.two)}`, type: 'feed' }],
        },
        { id: `FEED:${String(subs.one)}`, bare_id: subs.one, name: 'One', unread: 2 },
      ],
    });
    expect(tree.items[3]).toMatchObject({ items: [{ name: 'Three', error: 'HTTP 500' }] });
  });

  it('counts unread articles per feed, label, category, and overall', async () => {
    expect(await call('getUnread')).toEqual({ unread: 5 });
    const counters = await call<Record<string, unknown>[]>('getCounters', { output_mode: 'flc' });
    expect(counters).toEqual(
      expect.arrayContaining([
        { id: 'global-unread', counter: 5 },
        { id: 'subscribed-feeds', counter: 3 },
        { id: -4, counter: 5, auxcounter: 0 },
        expect.objectContaining({ id: subs.one, counter: 2, has_img: 1 }),
        expect.objectContaining({ id: subs.three, counter: 2, error: 'HTTP 500' }),
        { id: labelFeed(), counter: 1, auxcounter: 0 },
        { id: cats.tech, kind: 'cat', counter: 3 },
      ]),
    );
    const feedsOnly = await call<{ kind?: string }[]>('getCounters', { output_mode: 'f' });
    expect(feedsOnly.some((item) => item.kind === 'cat')).toBe(false);
  });
});

describe('TTRSS headlines and articles', () => {
  type Headline = Record<string, unknown> & { id: number; title: string };
  const headlines = (params: Record<string, unknown>) => call<Headline[]>('getHeadlines', params);

  it('selects feeds, categories, special feeds, labels, and tags', async () => {
    expect(titles(await headlines({ feed_id: subs.one }))).toEqual(['apple', 'banana']);
    expect(titles(await headlines({ feed_id: cats.tech, is_cat: true }))).toEqual([
      'apple',
      'cherry',
      'banana',
    ]);
    expect(titles(await headlines({ feed_id: 0, is_cat: true }))).toEqual(['date', 'elder']);
    expect(titles(await headlines({ feed_id: '-4', limit: 2, skip: 1 }))).toEqual([
      'cherry',
      'banana',
    ]);
    expect(titles(await headlines({ feed_id: labelFeed() }))).toEqual(['cherry']);
    expect(titles(await headlines({ feed_id: 'Recipes' }))).toEqual(['date']);
    expect(await headlines({ feed_id: 0 })).toEqual([]);
  });

  it('leaves feeds hidden from All out of All articles, Fresh, and their counts', async () => {
    await db
      .update(subscriptions)
      .set({ hideFromAll: true })
      .where(eq(subscriptions.id, subs.two ?? 0));
    expect(titles(await headlines({ feed_id: '-4' }))).toEqual([
      'apple',
      'banana',
      'date',
      'elder',
    ]);
    expect(titles(await headlines({ feed_id: '-3' }))).toEqual(['apple']);
    expect(titles(await headlines({ feed_id: subs.two }))).toEqual(['cherry']);
    expect(await call('getUnread')).toEqual({ unread: 4 });
    const counters = await call<Record<string, unknown>[]>('getCounters', { output_mode: 'fl' });
    expect(counters).toEqual(
      expect.arrayContaining([
        { id: -4, counter: 4, auxcounter: 0 },
        expect.objectContaining({ id: subs.two, counter: 1 }),
      ]),
    );
  });

  it('applies view modes, ordering, since_id, and search', async () => {
    await call('updateArticle', { article_ids: String(ids.apple), mode: 0, field: 2 });
    await call('updateArticle', { article_ids: String(ids.banana), mode: 1, field: 0 });
    expect(titles(await headlines({ feed_id: -4, view_mode: 'unread' }))).not.toContain('apple');
    expect(titles(await headlines({ feed_id: -4, view_mode: 'marked' }))).toEqual(['banana']);
    expect(titles(await headlines({ feed_id: subs.one, order_by: 'date_reverse' }))).toEqual([
      'banana',
      'apple',
    ]);
    expect(titles(await headlines({ feed_id: -4, since_id: ids.cherry }))).toEqual(
      ['date', 'elder'].filter((key) => (ids[key] ?? 0) > (ids.cherry ?? 0)),
    );
    expect(
      titles(await headlines({ feed_id: subs.two, search: 'banana', search_mode: 'all_feeds' })),
    ).toEqual(['banana']);
  });

  it('returns headline fields, content, attachments, labels, and the header on request', async () => {
    const [cherry] = await headlines({ feed_id: subs.two, show_excerpt: true });
    expect(cherry).toMatchObject({
      id: ids.cherry,
      unread: true,
      marked: false,
      published: false,
      title: 'cherry',
      link: 'https://example/cherry',
      feed_id: subs.two,
      feed_title: 'Two',
      author: 'Ann',
      score: 0,
      note: null,
      excerpt: 'Cherry',
      labels: [[labelFeed(), 'Later', '#ffffff', '#b00020']],
      tags: [],
      updated: expect.any(Number) as number,
    });
    expect(cherry).not.toHaveProperty('content');
    const [apple] = await headlines({
      feed_id: subs.one,
      limit: 1,
      show_content: true,
      include_attachments: true,
    });
    expect(apple?.content).toContain('Apple');
    expect(apple?.attachments).toEqual([
      {
        id: 1,
        post_id: ids.apple,
        content_url: 'https://example/a.mp3',
        content_type: 'audio/mpeg',
        title: '',
        duration: '60',
        width: 0,
        height: 0,
      },
    ]);
    const withHeader = await call<[Record<string, unknown>, Headline[]]>('getHeadlines', {
      feed_id: subs.one,
      include_header: true,
    });
    expect(withHeader[0]).toEqual({ id: subs.one, is_cat: false, first_id: ids.apple });
    expect(titles(withHeader[1])).toEqual(['apple', 'banana']);
  });

  it('serves articles by id, through the image proxy when the user turned it on', async () => {
    const found = await call<Headline[]>('getArticle', {
      article_id: `${String(ids.apple)},${String(ids.cherry)},999999`,
    });
    expect(titles(found)).toEqual(['apple', 'cherry']);
    expect(found[0]).toMatchObject({
      comments: '',
      attachments: [{ content_url: 'https://example/a.mp3' }],
    });
    expect(found[0]?.content).toContain('https://img.example/a.png');
    await services.prefs.update(pat, { proxyImages: true });
    const [proxied] = await call<Headline[]>('getArticle', { article_id: ids.apple });
    expect(proxied?.content).toContain('/api/v1/images/');
  });
});

describe('TTRSS article state', () => {
  const entry = (id: number | undefined) => services.entries.entries.get(pat, id ?? 0);

  it('sets, clears, and toggles flags and notes', async () => {
    const both = `${String(ids.apple)},${String(ids.banana)}`;
    expect(await call('updateArticle', { article_ids: both, mode: 1, field: 0 })).toEqual({
      status: 'OK',
      updated: 2,
    });
    await call('updateArticle', { article_ids: String(ids.apple), mode: 2, field: 0 });
    expect((await entry(ids.apple)).starred).toBe(false);
    expect((await entry(ids.banana)).starred).toBe(true);
    await call('updateArticle', { article_ids: both, mode: 2, field: 2 });
    expect((await entry(ids.apple)).unread).toBe(false);
    await call('updateArticle', { article_ids: String(ids.apple), mode: 1, field: 1 });
    expect((await entry(ids.apple)).published).toBe(true);
    await call('updateArticle', {
      article_ids: String(ids.apple),
      mode: 0,
      field: 3,
      data: 'Try pears',
    });
    expect((await entry(ids.apple)).note).toBe('Try pears');
    const wrong = await ttrss(app, {
      op: 'updateArticle',
      sid,
      article_ids: '1',
      mode: 1,
      field: 9,
    });
    expect(wrong.content).toEqual({ error: 'INCORRECT_USAGE' });
  });

  it('catches up feeds and categories, optionally by age', async () => {
    await call('catchupFeed', { feed_id: subs.one, is_cat: false, mode: '1day' });
    expect((await entry(ids.banana)).unread).toBe(false);
    expect((await entry(ids.apple)).unread).toBe(true);
    await call('catchupFeed', { feed_id: cats.tech, is_cat: true });
    expect((await entry(ids.cherry)).unread).toBe(false);
    expect(await call('getUnread')).toEqual({ unread: 2 });
  });

  it('lists labels for an article and assigns them', async () => {
    const forApple = await call('getLabels', { article_id: ids.apple });
    expect(forApple).toEqual([
      {
        id: labelFeed(),
        caption: 'Later',
        fg_color: '#ffffff',
        bg_color: '#b00020',
        checked: false,
      },
    ]);
    const both = `${String(ids.apple)},${String(ids.cherry)}`;
    expect(
      await call('setArticleLabel', { article_ids: both, label_id: labelFeed(), assign: true }),
    ).toEqual({
      status: 'OK',
      updated: 1,
    });
    expect((await entry(ids.apple)).labels).toEqual([label]);
    await call('setArticleLabel', { article_ids: both, label_id: labelFeed(), assign: false });
    expect((await entry(ids.cherry)).labels).toEqual([]);
  });

  it('answers known preferences and logs unknown ones', async () => {
    expect(await call('getPref', { pref_name: 'FRESH_ARTICLE_MAX_AGE' })).toEqual({ value: 24 });
    expect(await call('getPref', { pref_name: 'ENABLE_FEED_CATS' })).toEqual({ value: true });
    expect(await call('getPref', { pref_name: 'MYSTERY' })).toEqual({ value: null });
    expect(logs.filter((line) => line.unsupported === 'getPref MYSTERY')).toHaveLength(1);
  });
});

describe('TTRSS subscriptions', () => {
  it('subscribes with TTRSS status codes', async () => {
    fetcher
      .set('https://new.example/rss', { body: rss('New') })
      .set('https://page.example/', {
        body: htmlPage(
          { href: 'https://new.example/a' },
          { href: 'https://new.example/b', title: 'B' },
        ),
        contentType: 'text/html',
      })
      .set('https://plain.example/', {
        body: '<html><body>hi</body></html>',
        contentType: 'text/html',
      })
      .set('https://down.example/rss', new FetchError('network', 'down'));
    const subscribe = (feed_url: string, category_id?: number) =>
      call<{ status: Record<string, unknown> }>('subscribeToFeed', { feed_url, category_id });
    const added = await subscribe('https://new.example/rss', cats.web);
    expect(added.status).toMatchObject({ code: 1, feed_id: expect.any(Number) as number });
    expect((await subscribe('https://new.example/rss')).status).toMatchObject({ code: 0 });
    expect((await subscribe('not a url')).status).toMatchObject({ code: 2 });
    expect((await subscribe('https://plain.example/')).status).toMatchObject({ code: 3 });
    expect((await subscribe('https://page.example/')).status).toEqual({
      code: 4,
      feeds: { 'https://new.example/a': 'https://new.example/a', 'https://new.example/b': 'B' },
    });
    expect((await subscribe('https://down.example/rss')).status).toMatchObject({ code: 5 });
    const [view] = (await services.feeds.subscriptions.list(pat)).filter(
      (v) => v.subscription.id === added.status.feed_id,
    );
    expect(view?.subscription.categoryId).toBe(cats.web);
  });

  it('unsubscribes and requests updates', async () => {
    expect(await call('updateFeed', { feed_id: subs.two })).toEqual({ status: 'OK' });
    expect(await call('unsubscribeFeed', { feed_id: subs.two })).toEqual({ status: 'OK' });
    const again = await ttrss(app, { op: 'unsubscribeFeed', sid, feed_id: subs.two });
    expect(again).toMatchObject({ status: 1, content: { error: 'FEED_NOT_FOUND' } });
    const others = await ttrss(app, { op: 'unsubscribeFeed', sid, feed_id: subs.bob });
    expect(others.content).toEqual({ error: 'FEED_NOT_FOUND' });
    const [bobs] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subs.bob ?? 0));
    expect(bobs).toBeDefined();
  });
});
