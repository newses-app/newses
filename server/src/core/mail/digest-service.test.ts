import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  categories,
  digestState,
  entries,
  feedSources,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingMailer, RecordingRealtime, silentLogger } from '../../test/fakes.ts';
import { deriveKey } from '../crypto.ts';
import { EntryService } from '../entries/entries.ts';
import { Ingester } from '../feeds/ingest.ts';
import type { ParsedEntry } from '../feeds/parse.ts';
import { PrefsService } from '../prefs.ts';
import { DIGEST_MAX_ENTRIES, DigestService } from './digest-service.ts';

const APP_URL = 'https://reader.example';

let database: TestDatabase;
let db: Db;
let mailer: RecordingMailer;
let prefs: PrefsService;
let digest: DigestService;
let ingester: Ingester;
let now: Date;
let alice: number;
let bob: number;
let carol: number;
/** Feed sources: `tech` in alice's Tech category, `news` outside any, `quiet` hidden from All. */
let tech: number;
let news: number;
let quiet: number;
const feed: Record<string, number> = {};

let guid = 0;
/** Entries published a minute apart, the last newest. */
const items = (n: number, title: string): ParsedEntry[] =>
  Array.from({ length: n }, (_, i) => {
    const id = `g${String(++guid)}`;
    return {
      guid: id,
      link: `https://site.example/${id}`,
      title: `${title} ${String(i + 1)}`,
      author: null,
      content: `<p>About ${title} ${String(i + 1)}.</p>`,
      // Within the purge window, which ingest skips entries before.
      publishedAt: new Date(Date.now() - 86_400_000 + guid * 60_000),
      updatedAt: null,
      enclosures: [],
      categories: [],
      lang: null,
    };
  });

async function turnOn(userId: number, changes: Parameters<PrefsService['update']>[1] = {}) {
  await prefs.update(userId, {
    digestFrequency: 'daily',
    digestHour: 7,
    timeZone: 'Europe/Berlin',
    ...changes,
  });
  await digest.schedule(userId);
}

const stateOf = async (userId: number) =>
  (await db.select().from(digestState).where(eq(digestState.userId, userId)))[0];

const unreadOf = async (userId: number) =>
  (
    await db
      .select({ id: userEntries.id })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), eq(userEntries.unread, true)))
  ).length;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  // A Monday, 06:00 in Berlin.
  now = new Date('2026-06-15T04:00:00Z');
  mailer = new RecordingMailer();
  prefs = new PrefsService(db);
  const realtime = new RecordingRealtime();
  digest = new DigestService({
    db,
    mailer,
    prefs,
    entries: new EntryService(db, realtime),
    publicUrl: APP_URL,
    unsubscribeKey: deriveKey('test secret', 'digest-unsubscribe'),
    logger: silentLogger,
    now: () => now,
  });
  ingester = new Ingester(db, realtime, {
    updateIntervalSeconds: 1800,
    purgeDays: 30,
    disableAfterFailures: 3,
  });
  const [a, b, c] = await db
    .insert(users)
    .values([
      { login: 'alice', passwordHash: 'x', email: 'alice@example.com' },
      { login: 'bob', passwordHash: 'x' },
      { login: 'carol', passwordHash: 'x', email: 'carol@example.com' },
    ])
    .returning();
  alice = a?.id ?? 0;
  bob = b?.id ?? 0;
  carol = c?.id ?? 0;
  const sources = await db
    .insert(feedSources)
    .values([
      { url: 'https://tech.example/rss', title: 'Tech & feed' },
      { url: 'https://news.example/rss', title: 'News' },
      { url: 'https://quiet.example/rss', title: 'Quiet' },
    ])
    .returning();
  [tech, news, quiet] = sources.map((s) => s.id) as [number, number, number];
  const [category] = await db
    .insert(categories)
    .values({ userId: alice, title: 'Tech' })
    .returning();
  const subscribed = await db
    .insert(subscriptions)
    .values([
      { userId: alice, feedSourceId: tech, categoryId: category?.id ?? null },
      { userId: alice, feedSourceId: news },
      { userId: alice, feedSourceId: quiet, hideFromAll: true },
      { userId: bob, feedSourceId: news },
      { userId: carol, feedSourceId: news },
    ])
    .returning();
  feed.tech = subscribed[0]?.id ?? 0;
  feed.news = subscribed[1]?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('DigestService', () => {
  it('schedules the next digest at the hour in the time zone, starting after what is there', async () => {
    await ingester.ingest(news, null, items(2, 'Old'));
    await turnOn(alice);
    const [newest] = await db
      .select({ id: userEntries.id })
      .from(userEntries)
      .where(eq(userEntries.userId, alice))
      .orderBy(userEntries.id)
      .then((rows) => rows.slice(-1));
    expect(await stateOf(alice)).toMatchObject({
      watermark: newest?.id,
      nextDueAt: new Date('2026-06-15T05:00:00Z'),
      lastSentAt: null,
    });
    // Weekly on Wednesday at 18:00 in New York.
    await turnOn(alice, {
      digestFrequency: 'weekly',
      digestWeekday: 3,
      digestHour: 18,
      timeZone: 'America/New_York',
    });
    expect((await stateOf(alice))?.nextDueAt).toEqual(new Date('2026-06-17T22:00:00Z'));
    await prefs.update(alice, { digestFrequency: 'off' });
    await digest.schedule(alice);
    expect(await stateOf(alice)).toBeUndefined();
  });

  it('mails the unread entries that came in since, by category and feed, then waits a day', async () => {
    await ingester.ingest(tech, null, items(1, 'Before'));
    await turnOn(alice);
    await ingester.ingest(tech, null, items(2, 'Chip'));
    await ingester.ingest(news, null, items(1, 'Vote'));
    expect(await digest.sendDue()).toBe(0);

    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.sendDue()).toBe(1);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({
      to: ['alice@example.com'],
      subject: 'Newses digest: 3 unread articles',
    });
    expect(mail?.unsubscribeUrl).toMatch(
      new RegExp(`^${APP_URL}/public/unsubscribe/${String(alice)}\\.[\\w-]+$`),
    );
    const html = mail?.html ?? '';
    // Tech first, then the uncategorised; newest first within a feed.
    expect(html.indexOf('>Tech</h2>')).toBeLessThan(html.indexOf('>Uncategorised</h2>'));
    expect(html).toContain('>Tech &amp; feed</h3>');
    expect(html.indexOf('Chip 2')).toBeLessThan(html.indexOf('Chip 1'));
    expect(html).toMatch(new RegExp(`href="${APP_URL}/f${String(feed.tech)}/\\d+"`));
    expect(html).toContain('About Vote 1.');
    expect(html).not.toContain('Before 1');
    expect(mail?.text).toMatch(/You get this digest every day at 7:00\sAM \(Europe\/Berlin\)\./);
    expect(await unreadOf(alice)).toBe(4);
    expect(await stateOf(alice)).toMatchObject({
      nextDueAt: new Date('2026-06-16T05:00:00Z'),
      lastSentAt: now,
    });

    // Nothing new: no mail, and the next day after that.
    expect(await digest.sendDue()).toBe(0);
    now = new Date('2026-06-16T05:00:00Z');
    expect(await digest.sendDue()).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    expect((await stateOf(alice))?.nextDueAt).toEqual(new Date('2026-06-17T05:00:00Z'));
  });

  it('leaves out feeds hidden from All, low scores, and entries read already', async () => {
    await turnOn(alice);
    await ingester.ingest(quiet, null, items(1, 'Hidden'));
    await ingester.ingest(news, null, items(3, 'Vote'));
    const idOf = async (title: string) =>
      (
        await db
          .select({ id: userEntries.id })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .where(and(eq(userEntries.userId, alice), eq(entries.title, title)))
      )[0]?.id ?? 0;
    await db
      .update(userEntries)
      .set({ score: -1000 })
      .where(eq(userEntries.id, await idOf('Vote 1')));
    await db
      .update(userEntries)
      .set({ unread: false })
      .where(eq(userEntries.id, await idOf('Vote 2')));
    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.sendDue()).toBe(1);
    const html = mailer.sent[0]?.html ?? '';
    expect(mailer.sent[0]?.subject).toBe('Newses digest: 1 unread article');
    expect(html).toContain('Vote 3');
    expect(html).not.toContain('Vote 1');
    expect(html).not.toContain('Vote 2');
    expect(html).not.toContain('Hidden');
    // No categories among them: no category headings.
    expect(html).not.toContain('<h2');
  });

  it('lists at most 100 entries, counting the rest, and can mark the listed ones read', async () => {
    await turnOn(alice, { digestMarkRead: true });
    await ingester.ingest(news, null, items(DIGEST_MAX_ENTRIES + 3, 'Story'));
    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.sendDue()).toBe(1);
    const [mail] = mailer.sent;
    expect(mail?.subject).toBe('Newses digest: 103 unread articles');
    expect(mail?.html).toContain('And 3 more unread articles in Newses.');
    expect(mail?.html).toContain('The articles in this digest are now marked read.');
    expect(mail?.html).not.toContain('>Story 1<');
    expect(mail?.html).toContain('>Story 103<');
    // The oldest three are left unread, but the next digest starts after them.
    expect(await unreadOf(alice)).toBe(3);
    now = new Date('2026-06-16T05:00:00Z');
    expect(await digest.sendDue()).toBe(0);
  });

  it('keeps what came in for a user without a confirmed address', async () => {
    await turnOn(bob);
    const before = (await stateOf(bob))?.watermark;
    await ingester.ingest(news, null, items(1, 'Vote'));
    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.sendDue()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await stateOf(bob)).toMatchObject({
      watermark: before,
      nextDueAt: new Date('2026-06-16T05:00:00Z'),
    });
  });

  it('tries again with the next digest when the mail fails', async () => {
    await turnOn(alice);
    await ingester.ingest(news, null, items(1, 'Vote'));
    now = new Date('2026-06-15T05:00:00Z');
    mailer.failure = new Error('relay down');
    expect(await digest.sendDue()).toBe(0);
    mailer.failure = null;
    expect((await stateOf(alice))?.nextDueAt).toEqual(new Date('2026-06-16T05:00:00Z'));
    now = new Date('2026-06-16T05:00:00Z');
    expect(await digest.sendDue()).toBe(1);
    expect(mailer.sent[0]?.html).toContain('Vote 1');
  });

  it('sends to at most the batch each run, the rest on the next', async () => {
    await turnOn(alice);
    await turnOn(carol);
    await ingester.ingest(news, null, items(1, 'Vote'));
    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.sendDue(1)).toBe(1);
    expect(await digest.sendDue(1)).toBe(1);
    expect(await digest.sendDue(1)).toBe(0);
    expect(mailer.sent.map((mail) => mail.to[0]).sort()).toEqual([
      'alice@example.com',
      'carol@example.com',
    ]);
  });

  it('starts users with digests on but no state from now, and forgets those turned off', async () => {
    await ingester.ingest(news, null, items(1, 'Vote'));
    // As after a restore: the preference without the state.
    await prefs.update(alice, { digestFrequency: 'daily', digestHour: 7 });
    expect(await digest.sendDue()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect((await stateOf(alice))?.nextDueAt).toEqual(new Date('2026-06-15T07:00:00Z'));

    await prefs.update(alice, { digestFrequency: 'off' });
    now = new Date('2026-06-15T07:00:00Z');
    expect(await digest.sendDue()).toBe(0);
    expect(await stateOf(alice)).toBeUndefined();
  });

  it('turns digests off from a signed unsubscribe token', async () => {
    await turnOn(alice);
    const token = digest.unsubscribeToken(alice);
    expect(digest.tokenUser(token)).toBe(alice);
    expect(digest.tokenUser(`${String(carol)}${token.slice(String(alice).length)}`)).toBeNull();
    expect(digest.tokenUser(`${token}x`)).toBeNull();
    expect(digest.tokenUser('nonsense')).toBeNull();
    expect(await digest.unsubscribe('nonsense')).toBe(false);

    expect(await digest.unsubscribe(token)).toBe(true);
    expect((await prefs.get(alice)).digestFrequency).toBe('off');
    expect(await stateOf(alice)).toBeUndefined();

    await db.delete(users).where(inArray(users.id, [alice]));
    expect(await digest.unsubscribe(token)).toBe(false);
  });

  it('sends nothing without mail or a public URL', async () => {
    const off = new DigestService({
      db,
      mailer: null,
      prefs,
      entries: new EntryService(db, new RecordingRealtime()),
      publicUrl: APP_URL,
      unsubscribeKey: Buffer.alloc(32),
      logger: silentLogger,
    });
    expect(off.enabled).toBe(false);
    expect(digest.enabled).toBe(true);
    await turnOn(alice);
    now = new Date('2026-06-15T05:00:00Z');
    expect(await off.sendDue()).toBe(0);
  });
});
