import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  RecordingMailer,
  RecordingQueue,
  RecordingRealtime,
  silentLogger,
} from '../../test/fakes.ts';
import { deriveKey } from '../crypto.ts';
import { EntryService } from '../entries/entries.ts';
import { Ingester } from '../feeds/ingest.ts';
import type { ParsedEntry } from '../feeds/parse.ts';
import type { DomainError } from '../errors.ts';
import type { DigestComposeInput, DigestComposer, DigestTest } from '../plugins/catalog.ts';
import { PrefsService } from '../prefs.ts';
import type { Jobs } from '../jobs.ts';
import { DIGEST_MAX_ENTRIES, DigestService, type DigestDeps } from './digest-service.ts';

const APP_URL = 'https://reader.example';

/** A composer's test run, for composers whose tests are not what is tested. */
const untested: DigestComposer['composeTest'] = () => Promise.reject(new Error('not tested'));

let database: TestDatabase;
let db: Db;
let mailer: RecordingMailer;
let prefs: PrefsService;
let digest: Digests;
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

/** The digests, with the jobs they queue and a send of those due, as a dispatch and its jobs do. */
class Digests extends DigestService {
  readonly queue: RecordingQueue;

  constructor(deps: Omit<DigestDeps, 'queue'>) {
    const queue = new RecordingQueue();
    super({ ...deps, queue });
    this.queue = queue;
  }

  /** The queued digest jobs, taken from the queue. */
  takeJobs(): Jobs['digest.send'][] {
    return this.queue.jobs.splice(0).map((job) => job.data as Jobs['digest.send']);
  }

  /** Queues the due digests and runs their jobs; returns how many were sent. */
  async sendDue(options: { limit?: number } = {}): Promise<number> {
    await this.dispatchDue(options);
    let sent = 0;
    for (const job of this.takeJobs()) if (await this.runJob(job)) sent++;
    return sent;
  }
}

/** The digests, with plugins' additions from `composer`. */
const digestWith = (composer: DigestComposer | null = null) =>
  new Digests({
    db,
    mailer,
    prefs,
    entries: new EntryService(db, new RecordingRealtime()),
    publicUrl: APP_URL,
    unsubscribeKey: deriveKey('test secret', 'digest-unsubscribe'),
    logger: silentLogger,
    composer,
    now: () => now,
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
  digest = digestWith();
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

  it('gives plugins the unread entries it counts but does not list, newest first', async () => {
    await turnOn(alice);
    await ingester.ingest(news, null, items(DIGEST_MAX_ENTRIES + 3, 'Story'));
    now = new Date('2026-06-15T05:00:00Z');
    const given: DigestComposeInput[] = [];
    const composer: DigestComposer = {
      composes: true,
      composeTest: untested,
      compose: (input) => {
        given.push(input);
        return Promise.resolve([]);
      },
    };
    expect(await digestWith(composer).sendDue()).toBe(1);
    expect(given[0]?.entries).toHaveLength(DIGEST_MAX_ENTRIES);
    expect(given[0]?.more).toBe(3);
    expect(given[0]?.unlisted.map((entry) => [entry.title, entry.excerpt])).toEqual([
      ['Story 3', 'About Story 3.'],
      ['Story 2', 'About Story 2.'],
      ['Story 1', 'About Story 1.'],
    ]);
    expect(given[0]?.unlisted[0]).toMatchObject({
      contentHash: expect.any(String) as string,
      feed: expect.objectContaining({ withLogin: false }) as unknown,
    });
    // The digest itself still lists 100.
    expect(mailer.sent[0]?.html).toContain('And 3 more unread articles in Newses.');
    expect(mailer.sent[0]?.html).not.toContain('>Story 3<');
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
    expect(await digest.sendDue({ limit: 1 })).toBe(1);
    expect(await digest.sendDue({ limit: 1 })).toBe(1);
    expect(await digest.sendDue({ limit: 1 })).toBe(0);
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

  it("places plugins' overviews and text against listed entries, escaped", async () => {
    await turnOn(alice, { language: 'de' });
    await ingester.ingest(tech, null, items(2, 'Chip'));
    now = new Date('2026-06-15T05:00:00Z');
    const given: DigestComposeInput[] = [];
    const composer: DigestComposer = {
      composes: true,
      composeTest: untested,
      compose: (input) => {
        given.push(input);
        const [newest] = input.entries;
        return Promise.resolve([
          {
            pluginId: 'summary',
            name: 'Zusammenfassung <KI>',
            overview: '<script>alert(1)</script>\n\nZweiter & letzter\nTeil',
            sections: [],
            entries: new Map([
              [newest?.id ?? 0, 'Kurz: <a href="https://evil.example">hier</a>'],
              [999_999, 'Not listed'],
            ]),
          },
        ]);
      },
    };
    expect(await digestWith(composer).sendDue()).toBe(1);
    expect(given).toEqual([
      {
        userId: alice,
        language: 'de',
        frequency: 'daily',
        entries: [2, 1].map(
          (n) =>
            expect.objectContaining({
              title: `Chip ${String(n)}`,
              excerpt: `About Chip ${String(n)}.`,
              contentHash: expect.any(String) as string,
              unread: true,
              feed: expect.objectContaining({
                id: feed.tech,
                title: 'Tech & feed',
                url: 'https://tech.example/rss',
                withLogin: false,
              }) as unknown,
            }) as unknown,
        ),
        more: 0,
        unlisted: [],
      },
    ]);
    const [mail] = mailer.sent;
    const html = mail?.html ?? '';
    expect(html).toContain('>Zusammenfassung &lt;KI&gt;</p>');
    expect(html).toContain('>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toContain('>Zweiter &amp; letzter<br>Teil</p>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('evil.example"');
    expect(html).not.toContain('Not listed');
    // The overview before the entries, each note after its entry's excerpt.
    expect(html.indexOf('Zusammenfassung')).toBeLessThan(html.indexOf('Chip 2'));
    const note = html.indexOf('Kurz: &lt;a href=');
    expect(note).toBeGreaterThan(html.indexOf('About Chip 2.'));
    expect(note).toBeLessThan(html.indexOf('Chip 1'));
    expect(mail?.text).toContain(
      'Zusammenfassung <KI>\n\n<script>alert(1)</script>\n\nZweiter & letzter\nTeil',
    );
    expect(mail?.text).toContain('About Chip 2.\nKurz: <a href="https://evil.example">hier</a>\n');
  });

  it("places plugins' sections after their overview, linking the entries cited", async () => {
    await turnOn(alice);
    await ingester.ingest(tech, null, items(2, 'Chip'));
    now = new Date('2026-06-15T05:00:00Z');
    const cited: (number | undefined)[] = [];
    const composer: DigestComposer = {
      composes: true,
      composeTest: untested,
      compose: (input) => {
        const [newest, older] = input.entries;
        cited.push(newest?.id, older?.id);
        const cite = (entry: typeof newest) => ({
          id: entry?.id ?? 0,
          title: entry?.title ?? '',
          subscriptionId: entry?.feed?.id ?? null,
          feedTitle: entry?.feed?.title ?? null,
        });
        return Promise.resolve([
          {
            pluginId: 'summary',
            name: 'Summary',
            overview: null,
            sections: [
              {
                heading: 'Tech <b>',
                list: false,
                items: [{ text: 'Chips & more', entries: [cite(newest), cite(older)] }],
              },
              {
                heading: 'Other',
                list: true,
                items: [
                  { text: 'One', entries: [] },
                  {
                    text: 'Two',
                    entries: [{ id: 5, title: ' ', subscriptionId: null, feedTitle: null }],
                  },
                ],
              },
            ],
            entries: new Map(),
          },
        ]);
      },
    };
    expect(await digestWith(composer).sendDue()).toBe(1);
    const [mail] = mailer.sent;
    const html = mail?.html ?? '';
    const [newest, older] = cited.map((id) => `${APP_URL}/f${String(feed.tech)}/${String(id)}`);
    expect(html).toContain('>Tech &lt;b&gt;</p>');
    expect(html).toContain('>Chips &amp; more</p>');
    expect(html).toContain(
      `<a href="${String(newest)}" style="color:#3f51b5">Chip 2 - Tech &amp; feed</a>`,
    );
    expect(html).toContain(
      `<a href="${String(older)}" style="color:#3f51b5">Chip 1 - Tech &amp; feed</a>`,
    );
    expect(html).toMatch(/<ul [^>]*><li [^>]*>One<\/li><li [^>]*>Two<div/);
    expect(html).toContain(`<a href="${APP_URL}/all/5" style="color:#3f51b5">(untitled)</a>`);
    // The sections before the entries.
    expect(html.indexOf('Chips &amp; more')).toBeLessThan(html.indexOf('About Chip 2.'));
    expect(mail?.text).toContain(
      `Summary\n\nTech <b>\n\nChips & more\n  Chip 2 - Tech & feed: ${String(newest)}\n  Chip 1 - Tech & feed: ${String(older)}\n\nOther\n\n- One\n\n- Two\n  (untitled): ${APP_URL}/all/5\n`,
    );
  });

  it('sends the digest without additions when the plugins fail or none composes', async () => {
    await turnOn(alice);
    await ingester.ingest(news, null, items(1, 'Vote'));
    now = new Date('2026-06-15T05:00:00Z');
    const failing: DigestComposer = {
      composes: true,
      compose: () => Promise.reject(new Error('database gone')),
      composeTest: untested,
    };
    expect(await digestWith(failing).sendDue()).toBe(1);
    expect(mailer.sent[0]?.html).toContain('Vote 1');

    await ingester.ingest(news, null, items(1, 'Poll'));
    now = new Date('2026-06-16T05:00:00Z');
    const compose = vi.fn<DigestComposer['compose']>();
    expect(
      await digestWith({
        composes: false,
        compose,
        composeTest: untested,
      }).sendDue(),
    ).toBe(1);
    expect(compose).not.toHaveBeenCalled();
    expect(mailer.sent[1]?.html).toContain('Poll 1');
  });

  it('queues the due digests the longest due first, each sent once while its claim holds', async () => {
    await turnOn(alice);
    await turnOn(carol);
    await db
      .update(digestState)
      .set({ nextDueAt: new Date('2026-06-15T04:30:00Z') })
      .where(eq(digestState.userId, carol));
    await ingester.ingest(news, null, items(1, 'Vote'));
    now = new Date('2026-06-15T05:00:00Z');
    expect(await digest.dispatchDue()).toBe(2);
    // Claimed: the next dispatch queues neither again.
    expect(await digest.dispatchDue()).toBe(0);
    const jobs = digest.takeJobs();
    const lease = new Date(now.getTime() + 3_600_000).toISOString();
    expect(jobs).toEqual([
      { userId: carol, lease },
      { userId: alice, lease },
    ]);
    const [first, second] = jobs as [Jobs['digest.send'], Jobs['digest.send']];
    expect(await digest.runJob(first)).toBe(true);
    // Queued twice: the claim was taken, so nothing more is sent.
    expect(await digest.runJob(first)).toBe(false);
    expect(mailer.sent).toHaveLength(1);

    // Its lease lapsed and a later dispatch claimed it again: only the new job sends it.
    now = new Date('2026-06-15T06:01:00Z');
    expect(await digest.dispatchDue()).toBe(1);
    expect(await digest.runJob(second)).toBe(false);
    const [again] = digest.takeJobs() as [Jobs['digest.send']];
    expect(await digest.runJob(again)).toBe(true);
    expect(mailer.sent.map((mail) => mail.to)).toEqual([
      ['carol@example.com'],
      ['alice@example.com'],
    ]);
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
    const off = new Digests({
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

describe('test digests', () => {
  /** A composer whose plugins' tests add an overview, or end as `failure`, recording the input. */
  const testing = (...failures: DigestTest['failure'][]) => {
    const given: DigestComposeInput[] = [];
    const composer: DigestComposer = {
      composes: true,
      compose: () => Promise.reject(new Error('not a digest')),
      composeTest: (input) => {
        given.push(input);
        return Promise.resolve(
          failures.map((failure, n) => {
            const name = `Plugin <${String(n)}>`;
            return {
              name,
              addition: failure
                ? null
                : {
                    pluginId: `p${String(n)}`,
                    name,
                    overview: 'Votes, mostly.',
                    sections: [],
                    entries: new Map(),
                  },
              failure,
              detail: failure === 'error' ? 'HTTP 401 from the API' : null,
            };
          }),
        );
      },
    };
    return { composer, given };
  };

  /** Moves the user's entries with `title` back to having come in two days ago. */
  const cameInEarlier = (userId: number, title: string) =>
    db.execute(sql`
      UPDATE user_entries ue SET created_at = ${new Date(now.getTime() - 2 * 86_400_000).toISOString()}::timestamptz
      FROM entries e WHERE e.id = ue.entry_id AND ue.user_id = ${userId} AND e.title = ${title}`);

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: unknown) => (err as DomainError).detail?.reason ?? (err as DomainError).code,
    );

  it('refuses a test the user could not get, queueing none', async () => {
    const off = new Digests({
      db,
      mailer: null,
      prefs,
      entries: new EntryService(db, new RecordingRealtime()),
      publicUrl: APP_URL,
      unsubscribeKey: Buffer.alloc(32),
      logger: silentLogger,
    });
    await ingester.ingest(news, null, items(1, 'Vote'));
    expect(await refusal(off.requestTest(alice))).toBe('mail_unavailable');
    expect(await refusal(digest.requestTest(bob))).toBe('email_unconfirmed');
    // In before the last day: nothing to test with.
    await cameInEarlier(alice, 'Vote 1');
    expect(await refusal(digest.requestTest(alice))).toBe('digest_test_empty');
    expect([...off.takeJobs(), ...digest.takeJobs()]).toEqual([]);
  });

  it('queues the test, which its job sends', async () => {
    await ingester.ingest(news, null, items(1, 'Vote'));
    await digest.requestTest(alice);
    expect(mailer.sent).toHaveLength(0);
    const jobs = digest.takeJobs();
    expect(jobs).toEqual([{ userId: alice, test: true }]);
    expect(await digest.runJob({ userId: alice, test: true })).toBe(true);
    expect(mailer.sent[0]?.text).toContain('Vote 1');
    expect(mailer.sent[0]?.text).not.toContain('added nothing');
  });

  it("mails the last day's unread entries with the plugins' additions, changing nothing", async () => {
    await turnOn(alice, { digestMarkRead: true });
    const before = await stateOf(alice);
    await ingester.ingest(news, null, items(3, 'Vote'));
    await cameInEarlier(alice, 'Vote 1');
    await db
      .update(userEntries)
      .set({ unread: false })
      .where(
        inArray(
          userEntries.entryId,
          db.select({ id: entries.id }).from(entries).where(eq(entries.title, 'Vote 2')),
        ),
      );
    const { composer, given } = testing(null, 'error', 'empty');
    expect(await digestWith(composer).sendTest(alice)).toBe(true);
    expect(given.map((input) => input.entries.map((e) => e.title))).toEqual([['Vote 3']]);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({
      to: ['alice@example.com'],
      subject: 'Newses test digest: 1 unread article',
    });
    expect(mail?.unsubscribeUrl).toBeUndefined();
    const html = mail?.html ?? '';
    expect(html).toContain('A test digest for alice');
    expect(html).toContain('Votes, mostly.');
    expect(html).toContain('Plugin &lt;1&gt; failed and added nothing to this digest: HTTP 401');
    expect(html).toContain('Plugin &lt;2&gt; added nothing to this digest.');
    expect(html).toContain('Vote 3');
    expect(html).not.toContain('Vote 1');
    expect(html).not.toContain('Unsubscribe');
    expect(mail?.text).toContain(
      "Sent as a test: it doesn't change when your digests come, and marks nothing read.",
    );
    expect(mail?.text).not.toContain('You get this digest');
    // The digests' state and the entries as they were.
    expect(await stateOf(alice)).toEqual(before);
    expect(await unreadOf(alice)).toBe(2);
  });

  it('sends nothing to a user without an address, or with nothing to send', async () => {
    await ingester.ingest(news, null, items(1, 'Vote'));
    expect(await digest.sendTest(bob)).toBe(false);
    await cameInEarlier(alice, 'Vote 1');
    expect(await digest.sendTest(alice)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("gives plugins the test digest's input, refused with nothing in it", async () => {
    await ingester.ingest(news, null, items(3, 'Vote'));
    await cameInEarlier(alice, 'Vote 1');
    const input = await digest.testInput(alice);
    expect(input).toMatchObject({ userId: alice, language: 'en', frequency: 'daily', more: 0 });
    expect(input.entries.map((entry) => entry.title)).toEqual(['Vote 3', 'Vote 2']);
    expect(mailer.sent).toHaveLength(0);
    await cameInEarlier(alice, 'Vote 2');
    await cameInEarlier(alice, 'Vote 3');
    expect(await refusal(digest.testInput(alice))).toBe('digest_test_empty');
  });
});
