// Contract tests for the Google Reader API: requests as Google Reader clients send them, checked
// against the response shapes clients parse (ADR 0009).
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { reader, readerLogin, type ReaderRequest } from '../test/compat.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { MemoryBlobStore } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';
import { longItemId } from './compat/greader-ops.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
const fetcher = new FakeFetcher();
const blobs = new MemoryBlobStore();
const logs: Record<string, unknown>[] = [];
let pat = 0;
let token = '';
let ids: Record<string, number> = {};
let subs: Record<string, number> = {};
let cats: Record<string, number> = {};
let label = 0;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);
const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher, { blobs });
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  app = buildApp({ logger, healthChecks: {}, services, publicUrl: 'https://rss.example' });
  await app.ready();
});

/** pat: Tech › Web folders, three feeds, five entries, a label "Later", and a label "Tech". */
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
  cats = { tech: tech?.id ?? 0, web: web?.id ?? 0 };
  const sources = await db
    .insert(feedSources)
    .values([
      {
        url: 'https://one.example/rss',
        title: 'One',
        siteUrl: 'https://one.example/',
        faviconKey: 'favicons/one',
      },
      { url: 'https://two.example/rss', title: 'Two' },
      { url: 'https://three.example/rss', title: 'Three' },
    ])
    .returning();
  const subRows = await db
    .insert(subscriptions)
    .values([
      { userId: pat, feedSourceId: sources[0]?.id ?? 0, categoryId: cats.tech ?? null },
      { userId: pat, feedSourceId: sources[1]?.id ?? 0, categoryId: cats.web ?? null },
      { userId: pat, feedSourceId: sources[2]?.id ?? 0 },
      { userId: bob, feedSourceId: sources[0]?.id ?? 0 },
    ])
    .returning();
  subs = {
    one: subRows[0]?.id ?? 0,
    two: subRows[1]?.id ?? 0,
    three: subRows[2]?.id ?? 0,
    bob: subRows[3]?.id ?? 0,
  };
  const spec = [
    {
      key: 'apple',
      source: 0,
      sub: subs.one,
      hours: 1,
      content: '<p><img src="https://img.example/a.png"></p>',
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
        length: 1000,
      });
  }
  const colours = { fgColor: '#ffffff', bgColor: '#b00020' };
  label = (await services.entries.labels.create(pat, { caption: 'Later', ...colours })).id;
  await services.entries.labels.create(pat, { caption: 'Tech', ...colours });
  await services.entries.labels.setEntryLabels(pat, ids.cherry ?? 0, [label]);
  await services.entries.entries.setState(pat, [ids.banana ?? 0], { unread: false });
  await services.entries.entries.setState(pat, [ids.date ?? 0], { starred: true });
  const { password } = await services.appPasswords.create(pat, 'Phone');
  token = await readerLogin(app, 'pat', password);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const api = async <T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  path: string,
  request: Omit<ReaderRequest, 'token'> = {},
) => {
  const response = await reader(app, method, `/reader/api/0/${path}`, { token, ...request });
  if (response.statusCode !== 200)
    throw new Error(`${path} answered ${String(response.statusCode)}: ${response.body}`);
  return response.headers['content-type']?.startsWith('application/json')
    ? response.json<T>()
    : (response.body as T);
};

interface Item {
  id: string;
  title: string;
  categories: string[];
  [key: string]: unknown;
}
interface Contents {
  items: Item[];
  continuation?: string;
}
interface Ids {
  itemRefs: { id: string; directStreamIds: string[]; timestampUsec: string }[];
  continuation?: string;
}

const contents = (stream: string, query: Record<string, string | string[]> = {}) =>
  api<Contents>('GET', `stream/contents/${encodeURIComponent(stream)}`, {
    query: { output: 'json', ...query },
  });
const titles = (page: Contents) => page.items.map((item) => item.title);
const itemIds = (stream: string, query: Record<string, string | string[]> = {}) =>
  api<Ids>('GET', 'stream/items/ids', { query: { s: stream, output: 'json', ...query } });
const byTitle = async (title: string) =>
  (await contents('user/-/state/com.google/reading-list')).items.find((i) => i.title === title);

describe('Google Reader subscriptions and tags', () => {
  it('describes the user, subscriptions with flattened folders, and tags', async () => {
    expect(await api('GET', 'user-info')).toEqual({
      userId: String(pat),
      userName: 'pat',
      userProfileId: String(pat),
      userEmail: '',
    });
    const { subscriptions: list } = await api<{ subscriptions: Record<string, unknown>[] }>(
      'GET',
      'subscription/list',
      { query: { output: 'json' } },
    );
    expect(list).toHaveLength(3);
    expect(list.find((s) => s.title === 'One')).toMatchObject({
      id: `feed/${String(subs.one)}`,
      url: 'https://one.example/rss',
      htmlUrl: 'https://one.example/',
      categories: [{ id: 'user/-/label/Tech', label: 'Tech' }],
      iconUrl: expect.stringMatching(
        new RegExp(`^https://rss\\.example/feed-icons/[^/]+/${String(subs.one)}\\.ico$`),
      ) as string,
    });
    expect(list.find((s) => s.title === 'Two')?.categories).toEqual([
      { id: 'user/-/label/Tech/Web', label: 'Tech/Web' },
    ]);
    expect(list.find((s) => s.title === 'Three')).toMatchObject({ categories: [], iconUrl: '' });
    // The label "Tech" loses to the folder of the same name.
    expect(await api('GET', 'tag/list', { query: { output: 'json' } })).toEqual({
      tags: [
        { id: STARRED },
        { id: 'user/-/label/Tech', type: 'folder' },
        { id: 'user/-/label/Tech/Web', type: 'folder' },
        { id: 'user/-/label/Later', type: 'tag' },
      ],
    });
  });

  it('counts unread items per feed, folder, and tag', async () => {
    const { unreadcounts } = await api<{
      unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[];
    }>('GET', 'unread-count', { query: { output: 'json' } });
    const counts = Object.fromEntries(unreadcounts.map((c) => [c.id, c.count]));
    expect(counts).toEqual({
      'user/-/state/com.google/reading-list': 4,
      [`feed/${String(subs.one)}`]: 1,
      [`feed/${String(subs.two)}`]: 1,
      [`feed/${String(subs.three)}`]: 2,
      'user/-/label/Tech': 2,
      'user/-/label/Tech/Web': 1,
      'user/-/label/Later': 1,
    });
    const newest = unreadcounts.find((c) => c.id === 'user/-/label/Tech')?.newestItemTimestampUsec;
    expect(Number(newest) / 1000).toBeCloseTo(hoursAgo(1).getTime(), -4);
  });

  it('adds, edits, and removes subscriptions, and exports OPML', async () => {
    fetcher.set('https://new.example/rss', { body: rss('New') });
    const added = await api<{ numResults: number; streamId: string }>(
      'POST',
      'subscription/quickadd',
      { form: { quickadd: 'https://new.example/rss' } },
    );
    expect(added).toMatchObject({ numResults: 1, streamName: 'New' });
    expect(
      await api('POST', 'subscription/quickadd', { form: { quickadd: 'https://new.example/rss' } }),
    ).toMatchObject({ numResults: 1, streamId: added.streamId });
    expect(
      await api('POST', 'subscription/quickadd', { form: { quickadd: 'https://none.example/' } }),
    ).toMatchObject({ numResults: 0 });

    await api('POST', 'subscription/edit', {
      form: { ac: 'edit', s: added.streamId, t: 'Renamed', a: 'user/-/label/Fresh folder' },
    });
    const id = Number(added.streamId.slice('feed/'.length));
    let view = await services.feeds.subscriptions.get(pat, id);
    expect(view.subscription.title).toBe('Renamed');
    const folder = (await services.feeds.categories.list(pat)).find(
      (c) => c.title === 'Fresh folder',
    );
    expect(view.subscription.categoryId).toBe(folder?.id);
    await api('POST', 'subscription/edit', {
      form: { ac: 'edit', s: added.streamId, r: 'user/-/label/Fresh folder' },
    });
    view = await services.feeds.subscriptions.get(pat, id);
    expect(view.subscription.categoryId).toBeNull();
    await api('POST', 'subscription/edit', {
      form: { ac: 'edit', s: added.streamId, a: 'user/-/label/Tech/Web' },
    });
    view = await services.feeds.subscriptions.get(pat, id);
    expect(view.subscription.categoryId).toBe(cats.web);

    expect(await api('GET', 'subscription/export')).toContain('xmlUrl="https://new.example/rss"');
    expect(
      await api('POST', 'subscription/edit', { form: { ac: 'unsubscribe', s: added.streamId } }),
    ).toBe('OK');
    await expect(services.feeds.subscriptions.get(pat, id)).rejects.toThrow('not found');
    const others = await reader(app, 'POST', '/reader/api/0/subscription/edit', {
      token,
      form: { ac: 'unsubscribe', s: `feed/${String(subs.bob)}` },
    });
    expect(others.statusCode).toBe(404);

    fetcher.set('https://sub.example/rss', { body: rss('Sub') });
    await api('POST', 'subscription/edit', {
      form: { ac: 'subscribe', s: 'feed/https://sub.example/rss', a: 'user/-/label/Tech', t: 'S' },
    });
    const sub = (await services.feeds.subscriptions.list(pat)).find(
      (v) => v.source.url === 'https://sub.example/rss',
    );
    expect(sub?.subscription).toMatchObject({ title: 'S', categoryId: cats.tech });
  });

  it('renames and deletes folders and tags', async () => {
    await api('POST', 'rename-tag', {
      form: { s: 'user/-/label/Tech/Web', dest: 'user/-/label/Tech/Internet' },
    });
    await api('POST', 'rename-tag', {
      form: { s: 'user/-/label/Later', dest: 'user/-/label/Soon' },
    });
    const { tags } = await api<{ tags: { id: string }[] }>('GET', 'tag/list');
    expect(tags.map((t) => t.id)).toEqual([
      STARRED,
      'user/-/label/Tech',
      'user/-/label/Tech/Internet',
      'user/-/label/Soon',
    ]);
    await api('POST', 'disable-tag', { form: { s: 'user/-/label/Tech/Internet' } });
    await api('POST', 'disable-tag', { form: { s: 'user/-/label/Soon' } });
    // The folder's feed moves up to its parent.
    expect(
      (await services.feeds.subscriptions.get(pat, subs.two ?? 0)).subscription.categoryId,
    ).toBe(cats.tech);
    expect((await services.entries.labels.list(pat)).map((l) => l.caption)).toEqual(['Tech']);
    const missing = await reader(app, 'POST', '/reader/api/0/disable-tag', {
      token,
      form: { s: 'user/-/label/Nothing' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('Google Reader streams', () => {
  it('returns items in the shape clients parse', async () => {
    const apple = await byTitle('apple');
    expect(apple).toMatchObject({
      id: longItemId(ids.apple ?? 0),
      title: 'apple',
      author: 'Ann',
      published: expect.any(Number) as number,
      crawlTimeMsec: expect.stringMatching(/^\d{13}$/) as string,
      timestampUsec: expect.stringMatching(/^\d{16}$/) as string,
      canonical: [{ href: 'https://example/apple', type: 'text/html' }],
      alternate: [{ href: 'https://example/apple', type: 'text/html' }],
      categories: ['user/-/state/com.google/reading-list', 'user/-/label/Tech'],
      origin: {
        streamId: `feed/${String(subs.one)}`,
        title: 'One',
        htmlUrl: 'https://one.example/',
      },
      summary: { direction: 'ltr', content: '<p><img src="https://img.example/a.png"></p>' },
      enclosure: [{ href: 'https://example/a.mp3', type: 'audio/mpeg', length: '1000' }],
    });
    expect((await byTitle('cherry'))?.categories).toEqual([
      'user/-/state/com.google/reading-list',
      'user/-/label/Tech/Web',
      'user/-/label/Later',
    ]);
    expect((await byTitle('banana'))?.categories).toContain(READ);
    expect((await byTitle('date'))?.categories).toContain(STARRED);
    await services.prefs.update(pat, { proxyImages: true });
    expect(JSON.stringify((await byTitle('apple'))?.summary)).toContain('/api/v1/images/');
  });

  it('selects streams, states, times, order, and pages', async () => {
    const all = 'user/-/state/com.google/reading-list';
    expect(titles(await contents(all))).toEqual(['apple', 'cherry', 'banana', 'date', 'elder']);
    expect(titles(await contents(all, { xt: READ }))).toEqual(['apple', 'cherry', 'date', 'elder']);
    expect(titles(await contents(all, { it: STARRED }))).toEqual(['date']);
    expect(titles(await contents(READ))).toEqual(['banana']);
    expect(titles(await contents(STARRED))).toEqual(['date']);
    expect(titles(await contents('user/-/label/Tech'))).toEqual(['apple', 'cherry', 'banana']);
    expect(titles(await contents('user/-/label/Later'))).toEqual(['cherry']);
    expect(titles(await contents(`feed/${String(subs.three)}`))).toEqual(['date', 'elder']);
    expect(titles(await contents(`user/${String(pat)}/label/Tech/Web`))).toEqual(['cherry']);
    expect(titles(await contents(`feed/${String(subs.bob)}`))).toEqual([]);
    expect(titles(await contents('user/-/label/Nothing'))).toEqual([]);
    expect(titles(await contents(all, { r: 'o', n: '2' }))).toEqual(['elder', 'date']);
    const seconds = (hours: number) => String(Math.floor(hoursAgo(hours).getTime() / 1000));
    expect(titles(await contents(all, { ot: seconds(40) }))).toEqual(['apple', 'cherry', 'banana']);
    expect(titles(await contents(all, { nt: seconds(40) }))).toEqual(['date', 'elder']);

    const first = await contents(all, { n: '2' });
    expect(titles(first)).toEqual(['apple', 'cherry']);
    const second = await contents(all, { n: '2', c: first.continuation ?? '' });
    expect(titles(second)).toEqual(['banana', 'date']);
    const viaParam = await api<Contents>('GET', 'stream/contents', {
      query: { s: `feed/${String(subs.one)}` },
      prefix: '/api/greader.php',
    });
    expect(titles(viaParam)).toEqual(['apple', 'banana']);
  });

  it('leaves feeds hidden from All out of the reading list and its count', async () => {
    await db
      .update(subscriptions)
      .set({ hideFromAll: true })
      .where(eq(subscriptions.id, subs.one ?? 0));
    const all = 'user/-/state/com.google/reading-list';
    expect(titles(await contents(all))).toEqual(['cherry', 'date', 'elder']);
    expect(titles(await contents(`feed/${String(subs.one)}`))).toEqual(['apple', 'banana']);
    const { unreadcounts } = await api<{
      unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[];
    }>('GET', 'unread-count', { query: { output: 'json' } });
    const list = unreadcounts.find((c) => c.id === all);
    expect(list?.count).toBe(3);
    // The newest unread item left is cherry, two hours old, not apple from the hidden feed.
    expect(Number(list?.newestItemTimestampUsec) / 1000).toBeCloseTo(hoursAgo(2).getTime(), -4);
  });

  it('lists item ids, paging large lists by continuation', async () => {
    const unread = await itemIds('user/-/state/com.google/reading-list', { xt: READ });
    expect(unread.itemRefs.map((r) => Number(r.id))).toEqual([
      ids.apple,
      ids.cherry,
      ids.date,
      ids.elder,
    ]);
    expect(unread.itemRefs[0]).toEqual({
      id: String(ids.apple),
      directStreamIds: [`feed/${String(subs.one)}`],
      timestampUsec: expect.stringMatching(/^\d{16}$/) as string,
    });
    expect(unread.continuation).toBeUndefined();
    const starred = await itemIds(STARRED);
    expect(starred.itemRefs.map((r) => Number(r.id))).toEqual([ids.date]);
    const page = await itemIds('user/-/state/com.google/reading-list', { n: '3' });
    expect(page.itemRefs).toHaveLength(3);
    const rest = await itemIds('user/-/state/com.google/reading-list', {
      n: '3',
      c: page.continuation ?? '',
    });
    expect(rest.itemRefs.map((r) => Number(r.id))).toEqual([ids.date, ids.elder]);
  });

  it('returns items by id in long, hex, and decimal forms', async () => {
    const response = await api<Contents>('POST', 'stream/items/contents', {
      query: { output: 'json' },
      form: {
        i: [
          longItemId(ids.apple ?? 0),
          (ids.cherry ?? 0).toString(16).padStart(16, '0'),
          String(ids.elder),
          'nonsense',
          String((ids.elder ?? 0) + 1000),
        ],
      },
    });
    expect(titles(response)).toEqual(['apple', 'cherry', 'elder']);
  });
});

describe('Google Reader item state', () => {
  it('marks items read, unread, and starred, and tags them', async () => {
    const edit = (form: Record<string, string | string[]>) =>
      api('POST', 'edit-tag', { form: { T: 'token', ...form } });
    expect(await edit({ i: [String(ids.apple), longItemId(ids.cherry ?? 0)], a: READ })).toBe('OK');
    expect((await byTitle('apple'))?.categories).toContain(READ);
    expect((await byTitle('cherry'))?.categories).toContain(READ);
    await edit({ i: String(ids.apple), r: READ, a: STARRED });
    expect((await byTitle('apple'))?.categories).toEqual(
      expect.arrayContaining([STARRED]) as string[],
    );
    expect((await byTitle('apple'))?.categories).not.toContain(READ);
    await edit({ i: String(ids.apple), a: 'user/-/label/Reading' });
    await edit({ i: String(ids.cherry), r: 'user/-/label/Later' });
    expect((await byTitle('apple'))?.categories).toContain('user/-/label/Reading');
    expect((await byTitle('cherry'))?.categories).not.toContain('user/-/label/Later');
    const created = (await services.entries.labels.list(pat)).find((l) => l.caption === 'Reading');
    expect(created).toBeDefined();
  });

  it('marks streams read up to a time', async () => {
    const [apple] = await db
      .select({ createdAt: userEntries.createdAt })
      .from(userEntries)
      .where(eq(userEntries.id, ids.apple ?? 0));
    const usec = String((apple?.createdAt.getTime() ?? 0) * 1000 - 1000);
    expect(
      await api('POST', 'mark-all-as-read', {
        form: { s: `feed/${String(subs.three)}`, ts: '1000' },
      }),
    ).toBe('OK');
    expect(titles(await contents(READ))).toEqual(['banana']);
    await api('POST', 'mark-all-as-read', { form: { s: 'user/-/label/Tech', ts: usec } });
    expect(titles(await contents(READ))).toEqual(['banana']);
    await api('POST', 'mark-all-as-read', { form: { s: 'user/-/label/Tech' } });
    expect(titles(await contents(READ))).toEqual(['apple', 'cherry', 'banana']);
  });
});
