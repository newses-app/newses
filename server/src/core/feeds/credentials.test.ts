import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { entries, feedSources, subscriptions, userEntries, users } from '../../db/schema.ts';
import { type AuthFeedServer, startAuthFeedServer } from '../../test/auth-feed-server.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import {
  MemoryArchive,
  MemoryBlobStore,
  testFeedCredentials,
  testFeedDeps,
} from '../../test/fakes.ts';
import { deriveKey, seal } from '../crypto.ts';
import { DomainError } from '../errors.ts';
import { feedCredentialContext, FeedCredentialSealer } from './credentials.ts';
import { describeFetchFailure } from './fetch-failure.ts';
import { FetchError, HttpFetcher } from './http.ts';
import { createFeedServices, type FeedServices } from './index.ts';
import { Purger } from './purge.ts';

const READER = { login: 'reader', password: 'secret' };

let database: TestDatabase;
let db: Db;
let server: AuthFeedServer;
let fetcher: HttpFetcher;
let feeds: FeedServices;
let alice: number;
let bob: number;

const text = (body: Uint8Array) => new TextDecoder().decode(body);

/** The reason a call failed with, as clients see it. */
async function reasonOf(call: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof DomainError)) throw new Error('expected a DomainError');
  return err.detail?.reason;
}

async function subscribed(userId: number, url: string, credentials = READER) {
  const result = await feeds.subscriptions.subscribe(userId, url, null, credentials);
  if (result.status !== 'subscribed') throw new Error('expected a subscription');
  return result.subscription;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  server = await startAuthFeedServer();
  fetcher = new HttpFetcher({ allowPrivateNetworks: true });
});

beforeEach(async () => {
  await db.delete(users);
  await db.delete(feedSources);
  feeds = createFeedServices(testFeedDeps(db, fetcher));
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
  await fetcher.close();
  await server.close();
  await database.drop();
});

describe('HttpFetcher with credentials', () => {
  it('sends them to the feed’s origin, again after a redirect there', async () => {
    const direct = await fetcher.fetch(`${server.url}/basic.xml`, { credentials: READER });
    expect(text(direct.body)).toContain('Fetched as reader.');
    const redirected = await fetcher.fetch(`${server.url}/redirect.xml`, { credentials: READER });
    expect(redirected.url).toBe(`${server.url}/basic.xml`);
    expect(text(redirected.body)).toContain('Fetched as reader.');
  });

  it('never sends them across a redirect to another origin', async () => {
    const result = await fetcher.fetch(`${server.url}/elsewhere.xml`, { credentials: READER });
    expect(result.url).toBe(`${server.otherUrl}/leak.xml`);
    expect(text(result.body)).toContain('No credentials arrived');
  });

  it('says whether a refused request carried them', async () => {
    const url = `${server.url}/basic.xml`;
    const failure = async (credentials: typeof READER | null) => {
      const err: unknown = await fetcher.fetch(url, { credentials }).catch((e: unknown) => e);
      if (!(err instanceof FetchError)) throw new Error('expected a FetchError');
      return describeFetchFailure(url, err).detail.reason;
    };
    expect(await failure(null)).toBe('fetch_login_required');
    expect(await failure({ login: 'reader', password: 'nope' })).toBe('fetch_login_refused');
  });
});

describe('subscribing with credentials', () => {
  it('refuses a feed that needs a login without one, or with a wrong one', async () => {
    const url = `${server.url}/basic.xml`;
    expect(await reasonOf(feeds.subscriptions.subscribe(alice, url))).toBe('fetch_login_required');
    expect(
      await reasonOf(
        feeds.subscriptions.subscribe(alice, url, null, { login: 'reader', password: 'x' }),
      ),
    ).toBe('fetch_login_refused');
    expect(await db.select().from(feedSources)).toEqual([]);
  });

  it('gives each subscription a source of its own, its password sealed', async () => {
    const url = `${server.url}/basic.xml`;
    const mine = await subscribed(alice, url);
    const theirs = await subscribed(bob, url, { login: 'josé', password: 'pä:ss wörd' });
    expect(mine.source.id).not.toBe(theirs.source.id);
    expect(mine.source).toMatchObject({ url, authLogin: 'reader', title: 'Test feed: basic' });
    expect(mine.source.authPassword).not.toContain('secret');
    expect(testFeedCredentials().open(mine.source)).toEqual(READER);

    // Entries came from the subscribing fetch, as each user's own.
    const titles = await db
      .select({ userId: userEntries.userId, feedSourceId: entries.feedSourceId })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId));
    expect(titles.filter((t) => t.userId === alice).length).toBe(10);
    expect(
      titles.every((t) => t.feedSourceId === (t.userId === alice ? mine : theirs).source.id),
    ).toBe(true);

    expect(await reasonOf(feeds.subscriptions.subscribe(alice, url, null, READER))).toBe(
      'already_subscribed',
    );
  });

  it('keeps a feed with credentials apart from the shared source of its URL', async () => {
    const url = `${server.url}/open.xml`;
    const shared = await feeds.subscriptions.subscribe(bob, url);
    const own = await subscribed(alice, url);
    expect(shared.status === 'subscribed' && shared.subscription.source.id).not.toBe(own.source.id);
    // A user has one subscription per URL, with credentials or without.
    expect(await reasonOf(feeds.subscriptions.subscribe(alice, url))).toBe('already_subscribed');
  });
});

describe('fetching a feed with credentials', () => {
  it('sends them on every check, with validators', async () => {
    const { source } = await subscribed(alice, `${server.url}/basic.xml`);
    await feeds.updater.update(source.id);
    const [after] = await db.select().from(feedSources).where(eq(feedSources.id, source.id));
    expect(after).toMatchObject({ errorCount: 0, lastError: null });
    expect(after?.etag).not.toBeNull();
  });

  it('records a refused login, and one sealed under another secret', async () => {
    const { source } = await subscribed(alice, `${server.url}/basic.xml`);
    const sealer = testFeedCredentials();
    await db
      .update(feedSources)
      .set({ authPassword: sealer.seal(source.id, 'wrong'), etag: null })
      .where(eq(feedSources.id, source.id));
    await feeds.updater.update(source.id);
    let [after] = await db.select().from(feedSources).where(eq(feedSources.id, source.id));
    expect(after).toMatchObject({ errorCount: 1, lastErrorReason: 'fetch_login_refused' });

    const other = new FeedCredentialSealer(
      deriveKey('another secret of thirty-two chars!', 'feed-credentials'),
    );
    await db
      .update(feedSources)
      .set({ authPassword: other.seal(source.id, 'secret') })
      .where(eq(feedSources.id, source.id));
    await feeds.updater.update(source.id);
    [after] = await db.select().from(feedSources).where(eq(feedSources.id, source.id));
    expect(after).toMatchObject({ errorCount: 2, lastErrorReason: 'feed_login_unreadable' });
  });

  it('feeds the debugger with them', async () => {
    const view = await subscribed(alice, `${server.url}/basic.xml`);
    const debug = await feeds.feedDebugger.debug(alice, view.subscription.id);
    expect(debug.response?.status).toBe(200);
    expect(debug.entries).toHaveLength(10);
  });
});

describe('changing a subscription’s credentials', () => {
  it('tries new ones first, keeping the stored password when none is given', async () => {
    const view = await subscribed(alice, `${server.url}/basic.xml`);
    const id = view.subscription.id;
    expect(
      await reasonOf(
        feeds.subscriptions.update(alice, id, {
          credentials: { login: 'reader', password: 'nope' },
        }),
      ),
    ).toBe('fetch_login_refused');
    let { source } = await feeds.subscriptions.get(alice, id);
    expect(testFeedCredentials().open(source)).toEqual(READER);

    await feeds.subscriptions.update(alice, id, {
      credentials: { login: 'josé', password: 'pä:ss wörd' },
    });
    // A renamed login keeps the stored password when none is given; the server refuses it.
    expect(
      await reasonOf(feeds.subscriptions.update(alice, id, { credentials: { login: 'reader' } })),
    ).toBe('fetch_login_refused');
    ({ source } = await feeds.subscriptions.get(alice, id));
    expect(source.id).toBe(view.source.id);
    expect(testFeedCredentials().open(source)).toEqual({ login: 'josé', password: 'pä:ss wörd' });
  });

  it('moves between a source of its own and the shared one, keeping kept entries', async () => {
    const url = `${server.url}/open.xml`;
    const plain = await feeds.subscriptions.subscribe(alice, url);
    if (plain.status !== 'subscribed') throw new Error('expected a subscription');
    const id = plain.subscription.subscription.id;
    const shared = plain.subscription.source.id;
    const [first] = await db.select().from(userEntries).where(eq(userEntries.subscriptionId, id));
    await db
      .update(userEntries)
      .set({ starred: true })
      .where(eq(userEntries.id, first?.id ?? 0));

    await feeds.subscriptions.update(alice, id, { credentials: READER });
    const own = (await feeds.subscriptions.get(alice, id)).source;
    expect(own).toMatchObject({ url, authLogin: 'reader' });
    expect(own.id).not.toBe(shared);
    const held = await db.select().from(userEntries).where(eq(userEntries.userId, alice));
    expect(held.filter((ue) => ue.starred)).toEqual([
      expect.objectContaining({ id: first?.id, subscriptionId: null }),
    ]);
    expect(held.filter((ue) => ue.subscriptionId === id)).toHaveLength(10);

    await feeds.subscriptions.update(alice, id, { credentials: null });
    expect((await feeds.subscriptions.get(alice, id)).source.id).toBe(shared);
  });

  it('asks for a password when adding a login to a feed without one', async () => {
    const plain = await feeds.subscriptions.subscribe(alice, `${server.url}/open.xml`);
    if (plain.status !== 'subscribed') throw new Error('expected a subscription');
    const err: unknown = await feeds.subscriptions
      .update(alice, plain.subscription.subscription.id, { credentials: { login: 'reader' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
  });
});

describe('FeedCredentialSealer.reseal', () => {
  it('re-seals passwords sealed under another secret, and leaves its own', async () => {
    const previous = deriveKey('the previous secret of thirty-two chars', 'feed-credentials');
    const [a, b] = await db
      .insert(feedSources)
      .values([
        { url: 'https://a.example/rss', authLogin: 'a' },
        { url: 'https://a.example/rss', authLogin: 'b' },
      ])
      .returning();
    const sealer = testFeedCredentials();
    await db
      .update(feedSources)
      .set({ authPassword: seal(previous, 'pa', feedCredentialContext(a?.id ?? 0)) })
      .where(eq(feedSources.id, a?.id ?? 0));
    await db
      .update(feedSources)
      .set({ authPassword: sealer.seal(b?.id ?? 0, 'pb') })
      .where(eq(feedSources.id, b?.id ?? 0));

    expect(await sealer.reseal(db, previous)).toBe(1);
    const rows = await db.select().from(feedSources);
    expect(rows.map((row) => sealer.open(row)?.password).sort()).toEqual(['pa', 'pb']);
    await expect(
      sealer.reseal(
        db,
        deriveKey('a wrong secret of at least thirty-two chars', 'feed-credentials'),
      ),
    ).resolves.toBe(0);
  });
});

describe('purging a feed with credentials', () => {
  it('never archives its entries, and deletes the source with its subscription', async () => {
    const view = await subscribed(alice, `${server.url}/basic.xml`);
    await feeds.subscriptions.unsubscribe(alice, view.subscription.id);
    await db.update(entries).set({ lastSeenAt: new Date(0) });
    const archive = new MemoryArchive();
    const purger = new Purger(
      db,
      new MemoryBlobStore(),
      { updateIntervalSeconds: 1800, purgeDays: 60, disableAfterFailures: 3 },
      { archive },
    );
    const result = await purger.purge();
    expect(archive.rows).toEqual([]);
    expect(result).toMatchObject({ entries: 10, feedSources: 1, archived: 0 });
    expect(await db.select().from(subscriptions)).toEqual([]);
    expect(await db.select().from(feedSources)).toEqual([]);
  });
});
