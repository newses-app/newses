import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGES_SOURCE_URL } from '../core/feeds/pages.ts';
import { createDb, type Db } from '../db/client.ts';
import { entries, feedSources, userEntries } from '../db/schema.ts';
import { ttrss, ttrssLogin } from '../test/compat.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { RecordingRealtime } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let alice: { id: number; headers: Record<string, string> };
let bob: { id: number; headers: Record<string, string> };
const realtime = new RecordingRealtime();

const article = (title: string, text: string) =>
  `<html lang="en"><head><title>${title}</title></head><body><nav>Home · About</nav><article><h1>${title}</h1>${`<p>${text} with <a href="/more">a relative link</a> and enough words to count as an article body for extraction.</p>`.repeat(8)}<script>alert(1)</script></article></body></html>`;

const fetcher = new FakeFetcher()
  .set('https://news.example/story', {
    body: article('Big story', 'Story text'),
    contentType: 'text/html',
  })
  .set('https://data.example/x', { body: '{"not": "html"}', contentType: 'application/json' });

async function signIn(login: string) {
  const user = await services.users.create(login, `${login} password`);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: `${login} password` },
  });
  return {
    id: user.id,
    headers: {
      cookie: `rss_session=${res.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
      'x-csrf-token': res.json<{ csrfToken: string }>().csrfToken,
    },
  };
}

const publish = (who: { headers: Record<string, string> }, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/published-feed/pages',
    headers: who.headers,
    payload,
  });

/** The stored page behind one of the user's entries. */
async function stored(userEntryId: number) {
  const [row] = await db
    .select({ entry: entries, ue: userEntries, source: feedSources.url })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .innerJoin(feedSources, eq(feedSources.id, entries.feedSourceId))
    .where(eq(userEntries.id, userEntryId));
  if (!row) throw new Error(`No user entry ${String(userEntryId)}`);
  return row;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher, { realtime });
  app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services,
    publicUrl: 'https://reader.example',
  });
  alice = await signIn('alice');
  bob = await signIn('bob');
});

beforeEach(() => {
  fetcher.requested.length = 0;
  realtime.published.length = 0;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('published pages', () => {
  it('publishes a page with the given title and text, without fetching it', async () => {
    const response = await publish(alice, {
      url: 'https://Blog.example/post#comments',
      title: '  My <b>pick</b> ',
      text: 'Line one\nline two\n\n<script>x()</script> & more',
    });
    expect(response.statusCode).toBe(200);
    const entry = response.json<Record<string, unknown>>();
    expect(entry).toMatchObject({
      title: 'My pick',
      link: 'https://blog.example/post',
      feedTitle: 'blog.example',
      subscriptionId: null,
      published: true,
      unread: false,
    });
    expect(entry).not.toHaveProperty('content');
    expect(fetcher.requested).toEqual([]);
    expect(realtime.published).toEqual([{ userId: alice.id, event: { type: 'counters' } }]);

    const page = await stored(Number(entry.id));
    expect(page.source).toBe(PAGES_SOURCE_URL);
    expect(page.entry.content).toBe(
      '<p>Line one<br />line two</p><p>&lt;script&gt;x()&lt;/script&gt; &amp; more</p>',
    );

    const list = await app.inject({
      url: '/api/v1/entries?special=published',
      headers: alice.headers,
    });
    expect(list.json<{ entries: { id: number }[] }>().entries.map((e) => e.id)).toContain(entry.id);
    const { key } = (
      await app.inject({ url: '/api/v1/published-feed', headers: alice.headers })
    ).json<{ key: string }>();
    const feed = await app.inject({ url: `/public/feeds/${key}` });
    expect(feed.body).toContain('<link>https://blog.example/post</link>');
    expect(feed.body).toContain('My pick');
  });

  it('fills a missing title and text from the page, and republishes the same address', async () => {
    const first = (await publish(alice, { url: 'news.example/story' })).json<{ id: number }>();
    expect(fetcher.requested).toEqual(['https://news.example/story']);
    const page = await stored(first.id);
    expect(page.entry.title).toBe('Big story');
    expect(page.entry.content).toContain('Story text with <a href="https://news.example/more"');
    expect(page.entry.content).not.toContain('script');
    expect(page.entry.lang).toBe('en');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/entries/${String(first.id)}`,
      headers: alice.headers,
      payload: { published: false },
    });
    const again = await publish(alice, { url: 'https://news.example/story', title: 'Renamed' });
    expect(again.json()).toMatchObject({ id: first.id, title: 'Renamed', published: true });
    const republished = await stored(first.id);
    expect(republished.entry.id).toBe(page.entry.id);
    expect(republished.entry.content).toBe(page.entry.content);
    expect(republished.ue.sortAt.getTime()).toBeGreaterThan(page.ue.sortAt.getTime());
  });

  it('publishes pages it cannot read, titled with their address, keeping what it had', async () => {
    const missing = (await publish(alice, { url: 'https://down.example/gone' })).json<{
      id: number;
      title: string;
    }>();
    expect(missing.title).toBe('https://down.example/gone');
    expect((await stored(missing.id)).entry.content).toBeNull();

    const notHtml = (
      await publish(alice, { url: 'https://data.example/x', text: 'Worth a look' })
    ).json<{ id: number; title: string }>();
    expect(notHtml.title).toBe('https://data.example/x');
    expect((await stored(notHtml.id)).entry.content).toBe('<p>Worth a look</p>');
    await publish(alice, { url: 'https://data.example/x' });
    expect((await stored(notHtml.id)).entry.content).toBe('<p>Worth a look</p>');
  });

  it('gives each user their own page', async () => {
    const mine = (await publish(alice, { url: 'https://shared.example/a', title: 'Mine' })).json<{
      id: number;
    }>();
    const theirs = (await publish(bob, { url: 'https://shared.example/a', title: 'Theirs' })).json<{
      id: number;
    }>();
    const [a, b] = [await stored(mine.id), await stored(theirs.id)];
    expect(a.entry.id).not.toBe(b.entry.id);
    expect([a.entry.title, b.entry.title]).toEqual(['Mine', 'Theirs']);
    expect([a.ue.userId, b.ue.userId]).toEqual([alice.id, bob.id]);
  });

  it('refuses addresses that are not web pages, and requests that are too large', async () => {
    for (const url of ['javascript:alert(1)', 'ftp://files.example/x', ''])
      expect((await publish(alice, { url })).statusCode).toBe(400);
    expect(
      (await publish(alice, { url: 'https://a.example/', text: 'x'.repeat(100_001) })).statusCode,
    ).toBe(400);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/published-feed/pages',
      headers: { cookie: alice.headers.cookie ?? '' },
      payload: { url: 'https://a.example/' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/published-feed/pages',
      payload: { url: 'https://a.example/' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('publishes from TTRSS clients with shareToPublished, stripping tags', async () => {
    const { password } = await services.appPasswords.create(alice.id, 'Phone');
    const sid = await ttrssLogin(app, 'alice', password);
    const response = await ttrss(app, {
      op: 'shareToPublished',
      sid,
      url: 'https://tt.example/post',
      title: '<i>Shared</i> from TTRSS',
      content: '<p>First</p><p>Second &amp; last</p>',
    });
    expect(response).toMatchObject({ status: 0, content: { status: 'OK' } });
    const headlines = await ttrss<{ title: string; link: string }[]>(app, {
      op: 'getHeadlines',
      sid,
      feed_id: -2,
    });
    expect(headlines.content).toContainEqual(
      expect.objectContaining({ title: 'Shared from TTRSS', link: 'https://tt.example/post' }),
    );
    const [page] = await db
      .select()
      .from(entries)
      .where(eq(entries.link, 'https://tt.example/post'));
    expect(page?.content).toBe('<p>First</p><p>Second &amp; last</p>');

    expect(await ttrss(app, { op: 'shareToPublished', sid, title: 'No address' })).toMatchObject({
      status: 1,
      content: { error: 'INCORRECT_USAGE' },
    });
  });
});
