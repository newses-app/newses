import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  categories,
  enclosures,
  entries,
  feedSources,
  subscriptions,
  userEntries,
  userPrefs,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingRealtime } from '../../test/fakes.ts';
import { EntryService } from './entries.ts';
import { createEntryServices, type EntryServices } from './index.ts';
import { excerpt } from './text.ts';

let database: TestDatabase;
let db: Db;
let realtime: RecordingRealtime;
let services: EntryServices;
let alice: number;
let bob: number;
let ids: Record<string, number>;
let subs: Record<string, number>;
let cats: Record<string, number>;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);

async function seed() {
  const [a, b] = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  alice = a?.id ?? 0;
  bob = b?.id ?? 0;
  const [tech] = await db.insert(categories).values({ userId: alice, title: 'Tech' }).returning();
  const [web] = await db
    .insert(categories)
    .values({ userId: alice, title: 'Web', parentId: tech?.id ?? null })
    .returning();
  cats = { tech: tech?.id ?? 0, web: web?.id ?? 0 };
  const sources = await db
    .insert(feedSources)
    .values([
      { url: 'https://one.example/rss', title: 'One' },
      { url: 'https://two.example/rss', title: 'Two' },
      { url: 'https://three.example/rss', title: 'Three' },
    ])
    .returning();
  const [one, two, three] = sources.map((s) => s.id);
  const subRows = await db
    .insert(subscriptions)
    .values([
      { userId: alice, feedSourceId: one ?? 0, categoryId: cats.tech ?? null },
      { userId: alice, feedSourceId: two ?? 0, categoryId: cats.web ?? null, title: 'Custom two' },
      { userId: alice, feedSourceId: three ?? 0 },
      { userId: bob, feedSourceId: one ?? 0 },
    ])
    .returning();
  subs = { one: subRows[0]?.id ?? 0, two: subRows[1]?.id ?? 0, three: subRows[2]?.id ?? 0 };
  const bobSub = subRows[3]?.id ?? 0;

  const spec = [
    {
      key: 'apple',
      source: one,
      sub: subs.one,
      title: 'Apple pie recipe',
      hours: 1,
      content: '<p>Bake the <b>apple</b> pie &amp; serve.</p>',
    },
    {
      key: 'banana',
      source: one,
      sub: subs.one,
      title: 'Banana bread',
      hours: 30,
      content: '<p>Bread with banana</p>',
    },
    {
      key: 'cherry',
      source: two,
      sub: subs.two,
      title: 'Cherry tart',
      hours: 2,
      content: '<p>apple and cherry</p>',
    },
    {
      key: 'date',
      source: three,
      sub: subs.three,
      title: 'Date squares',
      hours: 48,
      content: null,
    },
  ];
  ids = {};
  for (const s of spec) {
    const [entry] = await db
      .insert(entries)
      .values({
        feedSourceId: s.source ?? 0,
        guid: s.key,
        title: s.title,
        link: `https://example/${s.key}`,
        content: s.content,
        contentHash: s.key,
        publishedAt: hoursAgo(s.hours),
      })
      .returning();
    const [ue] = await db
      .insert(userEntries)
      .values({
        userId: alice,
        entryId: entry?.id ?? 0,
        subscriptionId: s.sub ?? null,
        sortAt: hoursAgo(s.hours),
      })
      .returning();
    ids[s.key] = ue?.id ?? 0;
    if (s.key === 'apple') {
      await db.insert(enclosures).values({ entryId: entry?.id ?? 0, url: 'https://example/a.mp3' });
      await db.insert(userEntries).values({
        userId: bob,
        entryId: entry?.id ?? 0,
        subscriptionId: bobSub,
        sortAt: hoursAgo(1),
      });
    }
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  realtime = new RecordingRealtime();
  services = createEntryServices(db, realtime);
  await seed();
});

afterAll(async () => {
  await database.drop();
});

const titles = (list: { title: string | null }[]) => list.map((e) => e.title);

describe('excerpt', () => {
  it('strips markup, decodes entities, collapses whitespace, and truncates', () => {
    expect(excerpt('<p>A&amp;B&#33;\n <i>c</i>&nbsp;d</p>')).toBe('A&B! c d');
    expect(excerpt('<p>   </p>')).toBeNull();
    expect(excerpt('x'.repeat(300))).toHaveLength(250);
  });
});

describe('EntryService.list', () => {
  const list = (options: Partial<Parameters<EntryServices['entries']['list']>[1]> = {}) =>
    services.entries.list(alice, {
      stream: {},
      view: 'all',
      limit: 50,
      content: false,
      ...options,
    });

  it('lists the user’s entries newest first with feed titles and excerpts', async () => {
    const { entries: page, cursor, view } = await list();
    expect(titles(page)).toEqual([
      'Apple pie recipe',
      'Cherry tart',
      'Banana bread',
      'Date squares',
    ]);
    expect(page[0]).toMatchObject({
      feedTitle: 'One',
      excerpt: 'Bake the apple pie & serve.',
      unread: true,
    });
    expect(page[1]?.feedTitle).toBe('Custom two');
    expect(page[0]?.content).toBeUndefined();
    expect({ cursor, view }).toEqual({ cursor: null, view: 'all' });
  });

  it('paginates with a keyset cursor in every order', async () => {
    for (const order of ['newest', 'oldest', 'title'] as const) {
      const all = titles((await list({ order })).entries);
      const first = await list({ order, limit: 3 });
      const second = await list({ order, limit: 3, cursor: first.cursor ?? '' });
      expect([...titles(first.entries), ...titles(second.entries)]).toEqual(all);
      expect(second.cursor).toBeNull();
    }
    expect(titles((await list({ order: 'title' })).entries)[0]).toBe('Apple pie recipe');
  });

  it('selects subscriptions, categories with subcategories, uncategorised, and special feeds', async () => {
    expect(titles((await list({ stream: { subscriptionId: subs.one } })).entries)).toEqual([
      'Apple pie recipe',
      'Banana bread',
    ]);
    expect((await list({ stream: { categoryId: cats.tech } })).entries).toHaveLength(3);
    expect(titles((await list({ stream: { categoryId: cats.web } })).entries)).toEqual([
      'Cherry tart',
    ]);
    expect(titles((await list({ stream: { categoryId: 0 } })).entries)).toEqual(['Date squares']);
    expect(titles((await list({ stream: { special: 'fresh' } })).entries)).toEqual([
      'Apple pie recipe',
      'Cherry tart',
    ]);
    await db.insert(userPrefs).values({ userId: alice, key: 'freshMaxAgeHours', value: 36 });
    expect((await list({ stream: { special: 'fresh' } })).entries).toHaveLength(3);
  });

  it('applies unread and adaptive views', async () => {
    await services.entries.setState(alice, [ids.banana ?? 0, ids.apple ?? 0], { unread: false });
    expect(
      titles((await list({ stream: { subscriptionId: subs.one }, view: 'unread' })).entries),
    ).toEqual([]);
    const adaptive = await list({ stream: { subscriptionId: subs.one }, view: 'adaptive' });
    expect(adaptive.view).toBe('all');
    expect(adaptive.entries).toHaveLength(2);
    expect((await list({ view: 'adaptive' })).view).toBe('unread');
  });

  it('includes content and enclosures on request', async () => {
    const { entries: page } = await list({ stream: { subscriptionId: subs.one }, content: true });
    expect(page[0]?.content).toContain('<b>apple</b>');
    expect(page[0]?.enclosures).toMatchObject([{ url: 'https://example/a.mp3' }]);
    expect(page[1]?.enclosures).toEqual([]);
  });

  it('ends pages with content early once they reach the size budget', async () => {
    const small = new EntryService(db, realtime, { pageContentChars: 1 });
    const options = { stream: {}, view: 'all', limit: 50, content: true } as const;
    const first = await small.list(alice, options);
    expect(first.entries).toHaveLength(1);
    const second = await small.list(alice, { ...options, cursor: first.cursor ?? '' });
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    expect((await small.list(alice, { ...options, content: false })).entries).toHaveLength(4);
  });

  it.each([
    ['selective', 20_000],
    ['common', 0],
  ])('searches title and content, ranked, within the stream (%s terms)', async (_, threshold) => {
    const search = new EntryService(db, realtime, { selectiveMatches: threshold });
    const list = (options: Partial<Parameters<EntryService['list']>[1]>) =>
      search.list(alice, { stream: {}, view: 'all', limit: 50, content: false, ...options });
    const ranked = await list({ q: 'apple' });
    expect(titles(ranked.entries)).toEqual(['Apple pie recipe', 'Cherry tart']);
    const paged = await list({ q: 'apple', limit: 1 });
    const rest = await list({ q: 'apple', limit: 1, cursor: paged.cursor ?? '' });
    expect([...titles(paged.entries), ...titles(rest.entries)]).toEqual(titles(ranked.entries));
    expect(titles((await list({ q: 'apple', stream: { categoryId: cats.web } })).entries)).toEqual([
      'Cherry tart',
    ]);
    expect(titles((await list({ q: 'apple -pie', order: 'newest' })).entries)).toEqual([
      'Cherry tart',
    ]);
    const byTitle = await list({ q: 'apple', order: 'title', limit: 1 });
    const byTitleRest = await list({ q: 'apple', order: 'title', cursor: byTitle.cursor ?? '' });
    expect([...titles(byTitle.entries), ...titles(byTitleRest.entries)]).toEqual([
      'Apple pie recipe',
      'Cherry tart',
    ]);
    await expect(list({ order: 'relevance' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects malformed cursors', async () => {
    await expect(list({ cursor: 'nonsense' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('EntryService state', () => {
  it('gets one entry with content, only for its owner', async () => {
    expect(await services.entries.get(alice, ids.apple ?? 0)).toMatchObject({
      title: 'Apple pie recipe',
      content: expect.stringContaining('apple') as string,
      enclosures: [{ url: 'https://example/a.mp3' }],
    });
    await expect(services.entries.get(bob, ids.apple ?? 0)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('sets flags, records read time, skips no-op rows, and signals counters', async () => {
    const id = ids.apple ?? 0;
    expect(await services.entries.setState(alice, [id], { unread: false, starred: true })).toBe(1);
    const [row] = await db.select().from(userEntries).where(eq(userEntries.id, id));
    expect(row).toMatchObject({ unread: false, starred: true });
    expect(row?.readAt).not.toBeNull();
    expect(await services.entries.setState(alice, [id], { unread: false })).toBe(0);
    expect(await services.entries.setState(bob, [id], { unread: true })).toBe(0);
    expect(realtime.published).toEqual([{ userId: alice, event: { type: 'counters' } }]);
    expect(
      titles(
        (
          await services.entries.list(alice, {
            stream: { special: 'recentlyRead' },
            view: 'all',
            limit: 10,
            content: false,
          })
        ).entries,
      ),
    ).toEqual(['Apple pie recipe']);
  });

  it('catches up a stream, optionally by age or up to an id', async () => {
    expect(
      await services.entries.markRead(alice, { categoryId: cats.tech }, { olderThanDays: 1 }),
    ).toBe(1);
    expect(
      await services.entries.markRead(alice, { special: 'all' }, { maxId: ids.apple ?? 0 }),
    ).toBe(1);
    const unread = await db
      .select({ id: userEntries.id })
      .from(userEntries)
      .where(and(eq(userEntries.userId, alice), eq(userEntries.unread, true)));
    expect(unread.map((r) => r.id).sort()).toEqual([ids.cherry, ids.date].sort());
  });
});

describe('CounterService', () => {
  it('counts unread per subscription, category tree, and special feed', async () => {
    await services.entries.setState(alice, [ids.cherry ?? 0], { starred: true });
    const counters = await services.counters.get(alice);
    expect(counters.special).toEqual({ all: 4, fresh: 2, starred: 1, published: 0 });
    expect(counters.subscriptions).toEqual(
      expect.arrayContaining([
        { id: subs.one, unread: 2 },
        { id: subs.two, unread: 1 },
        { id: subs.three, unread: 1 },
      ]),
    );
    expect(counters.categories).toEqual(
      expect.arrayContaining([
        { id: 0, unread: 1 },
        { id: cats.tech, unread: 3 },
        { id: cats.web, unread: 1 },
      ]),
    );
    expect((await services.counters.get(bob)).special.all).toBe(1);
  });
});
