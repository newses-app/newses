import type { PushMessage } from '@newses/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  categories,
  feedSources,
  pushState,
  pushSubscriptions,
  sessions,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingPushSender, RecordingRealtime, silentLogger } from '../../test/fakes.ts';
import { Ingester } from '../feeds/ingest.ts';
import type { ParsedEntry } from '../feeds/parse.ts';
import { PushService } from './push-service.ts';

let database: TestDatabase;
let db: Db;
let sender: RecordingPushSender;
let push: PushService;
let ingester: Ingester;
let alice: number;
let bob: number;
let phone: number;
let laptop: number;
let bobSession: number;
/** Feed sources: `tech` and `more` in alice's Tech category, `news` outside any. */
let tech: number;
let more: number;
let news: number;
/** Alice's subscriptions to them. */
const feed: Record<string, number> = {};
let techCategory: number;
let bobNews: number;

const keys = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const device = (endpoint: string) => ({ endpoint: `https://push.example/${endpoint}`, keys });

let guid = 0;
const entries = (n: number): ParsedEntry[] =>
  Array.from({ length: n }, () => ({
    guid: `g${String(++guid)}`,
    link: null,
    title: 'Title',
    author: null,
    content: null,
    publishedAt: new Date(),
    updatedAt: null,
    enclosures: [],
    categories: [],
    lang: null,
  }));

const messages = () => sender.sent.map((s) => s.payload as PushMessage);
/** Moves alice's window back, as if her last message went out `minutes` ago. */
const sentAgo = (minutes: number) =>
  db
    .update(pushState)
    .set({ lastSentAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(pushState.userId, alice));

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  sender = new RecordingPushSender();
  push = new PushService({ db, sender, logger: silentLogger });
  ingester = new Ingester(
    db,
    new RecordingRealtime(),
    { updateIntervalSeconds: 1800, purgeDays: 30, disableAfterFailures: 3 },
    push,
  );
  const [a, b] = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x' },
      { login: 'bob', passwordHash: 'x' },
    ])
    .returning();
  alice = a?.id ?? 0;
  bob = b?.id ?? 0;
  const session = (userId: number, token: string) => ({
    userId,
    tokenHash: token,
    kind: 'bearer' as const,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const [p, l, o] = await db
    .insert(sessions)
    .values([session(alice, 'phone'), session(alice, 'laptop'), session(bob, 'bob')])
    .returning();
  phone = p?.id ?? 0;
  laptop = l?.id ?? 0;
  bobSession = o?.id ?? 0;
  const sources = await db
    .insert(feedSources)
    .values([
      { url: 'https://tech.example/rss', title: 'Tech feed' },
      { url: 'https://more.example/rss', title: 'More tech' },
      { url: 'https://news.example/rss', title: 'News' },
    ])
    .returning();
  [tech, more, news] = sources.map((s) => s.id) as [number, number, number];
  const [category] = await db
    .insert(categories)
    .values({ userId: alice, title: 'Tech' })
    .returning();
  techCategory = category?.id ?? 0;
  const subscribed = await db
    .insert(subscriptions)
    .values([
      { userId: alice, feedSourceId: tech, categoryId: techCategory },
      { userId: alice, feedSourceId: more, categoryId: techCategory },
      { userId: alice, feedSourceId: news },
      { userId: bob, feedSourceId: news },
    ])
    .returning();
  feed.tech = subscribed[0]?.id ?? 0;
  feed.more = subscribed[1]?.id ?? 0;
  feed.news = subscribed[2]?.id ?? 0;
  bobNews = subscribed[3]?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('PushService', () => {
  it('pushes entries that arrive after the first device subscribes, to every device', async () => {
    await ingester.ingest(tech, null, entries(2));
    await push.subscribe(alice, phone, device('phone'));
    await push.subscribe(alice, laptop, device('laptop'));

    await ingester.ingest(tech, null, entries(3));

    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example/laptop',
      'https://push.example/phone',
    ]);
    expect(sender.sent[0]?.options).toEqual({ ttlSeconds: 43_200, topic: 'new-entries' });
    expect(messages()[0]).toEqual({
      type: 'new-entries',
      count: 3,
      places: [{ title: 'Tech', count: 3 }],
      morePlaces: 0,
      target: `/f${String(feed.tech)}`,
    });
    const [row] = await db.select().from(pushSubscriptions).limit(1);
    expect(row?.lastSuccessAt).not.toBeNull();
  });

  it('names places by most entries and opens their category, or everything', async () => {
    await push.subscribe(alice, phone, device('phone'));
    // Within a window, so they go out together.
    await sentAgo(0);
    await ingester.ingest(tech, null, entries(1));
    await ingester.ingest(more, null, entries(2));
    await sentAgo(28);
    await push.flush();
    expect(messages().at(-1)).toMatchObject({
      count: 3,
      places: [{ title: 'Tech', count: 3 }],
      target: `/c${String(techCategory)}`,
    });

    await ingester.ingest(news, null, entries(4));
    await ingester.ingest(tech, null, entries(1));
    await sentAgo(28);
    await push.flush();
    expect(messages().at(-1)).toEqual({
      type: 'new-entries',
      count: 5,
      places: [
        { title: 'News', count: 4 },
        { title: 'Tech', count: 1 },
      ],
      morePlaces: 0,
      target: '/all',
    });
  });

  it('cuts long titles without splitting a character', async () => {
    await db
      .update(feedSources)
      .set({ title: `${'x'.repeat(79)}😀 and more` })
      .where(eq(feedSources.id, news));
    await push.subscribe(alice, phone, device('phone'));
    await ingester.ingest(news, null, entries(1));
    expect(messages()[0]?.places).toEqual([{ title: 'x'.repeat(79), count: 1 }]);
  });

  it('sends at most one message a window, then what waited', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await ingester.ingest(tech, null, entries(1));
    await ingester.ingest(tech, null, entries(2));
    expect(messages().map((m) => m.count)).toEqual([1]);

    expect(await push.flush()).toBe(0);
    // Windows end early enough for a 30-minute schedule.
    await sentAgo(27);
    expect(await push.flush()).toBe(1);
    expect(messages().map((m) => m.count)).toEqual([1, 2]);
    expect(await push.flush()).toBe(0);
  });

  it('sends nothing when the new entries were read, and keeps the window', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await ingester.ingest(news, null, entries(1));
    await ingester.ingest(news, null, entries(1));
    await db.update(userEntries).set({ unread: false });
    await sentAgo(40);

    expect(await push.flush()).toBe(0);
    const [state] = await db.select().from(pushState);
    expect(state?.pending).toBe(false);
    // Still 40 minutes ago, so the next entries go out at once.
    await ingester.ingest(news, null, entries(1));
    expect(messages().map((m) => m.count)).toEqual([1, 1]);
  });

  it('leaves users without devices alone', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await ingester.ingest(news, null, entries(1));
    expect(sender.sent.every((s) => s.endpoint.endsWith('/phone'))).toBe(true);
    expect(await db.select().from(pushState).where(eq(pushState.userId, bob))).toEqual([]);
  });

  it('forgets subscriptions the push service no longer knows', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await push.subscribe(alice, laptop, device('laptop'));
    sender.outcomes.set('https://push.example/phone', 'gone');
    sender.outcomes.set('https://push.example/laptop', 'failed');

    await ingester.ingest(tech, null, entries(1));

    const left = await db.select().from(pushSubscriptions);
    expect(left.map((s) => [s.endpoint, s.lastSuccessAt])).toEqual([
      ['https://push.example/laptop', null],
    ]);
  });

  it('keeps one subscription a session and moves an endpoint to its new session', async () => {
    await push.subscribe(alice, phone, device('old'));
    await push.subscribe(alice, phone, device('phone'));
    await push.subscribe(alice, laptop, device('phone'));

    const rows = await db.select().from(pushSubscriptions);
    expect(rows.map((r) => [r.sessionId, r.endpoint])).toEqual([
      [laptop, 'https://push.example/phone'],
    ]);
  });

  it('only starts from now for a first device, not for later ones', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await ingester.ingest(tech, null, entries(1));
    await ingester.ingest(tech, null, entries(1));
    await push.subscribe(alice, laptop, device('laptop'));
    await sentAgo(30);
    await push.flush();
    expect(messages().map((m) => m.count)).toEqual([1, 1, 1]);
  });

  it('ends with the session', async () => {
    await push.subscribe(alice, phone, device('phone'));
    await db.delete(sessions).where(eq(sessions.id, phone));
    expect(await db.select().from(pushSubscriptions)).toEqual([]);

    await push.subscribe(alice, laptop, device('laptop'));
    await push.unsubscribe(laptop);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('pushes nothing for a new subscription filling in old entries', async () => {
    await ingester.ingest(tech, null, entries(1));
    await push.subscribe(bob, bobSession, device('bob'));
    const [added] = await db
      .insert(subscriptions)
      .values({ userId: bob, feedSourceId: tech })
      .returning();

    await ingester.backfill(added?.id ?? 0);
    expect(await db.select().from(userEntries).where(eq(userEntries.userId, bob))).toHaveLength(1);
    expect(sender.sent).toEqual([]);
    // Nor counts it in the next message.
    await ingester.ingest(news, null, entries(1));
    expect(sender.sent.filter((s) => s.endpoint.endsWith('/bob')).map((s) => s.payload)).toEqual([
      expect.objectContaining({ count: 1, target: `/f${String(bobNews)}` }),
    ]);
  });
});
