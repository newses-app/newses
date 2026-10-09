import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractArticle } from '../core/feeds/fulltext.ts';
import { createDb, type Db } from '../db/client.ts';
import { entries } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { reader, readerLogin } from '../test/compat.ts';
import { RecordingQueue } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let headers: Record<string, string>;
let alice = 0;
const queue = new RecordingQueue();

const article = (text: string) =>
  `<html><head><title>Page</title></head><body><nav>Home · About · Contact</nav><article><h1>Story</h1>${`<p>${text} with <a href="/more">a relative link</a> and enough words to count as an article body for extraction.</p>`.repeat(8)}<img src="pic.png"><script>alert(1)</script></article><footer>Footer</footer></body></html>`;

const fetcher = new FakeFetcher()
  .set('https://a.example/rss', {
    body: rss('A', 'https://a.example/', [
      { guid: '1', title: 'One', link: 'https://a.example/1', description: 'Short summary' },
      { guid: '2', title: 'Two', link: 'https://a.example/2', description: 'Short' },
      { guid: '3', title: 'Three', link: 'https://a.example/3', description: 'Short' },
    ]),
  })
  .set('https://a.example/1', { body: article('First story text'), contentType: 'text/html' })
  .set('https://a.example/2', { body: '{"not": "html"}', contentType: 'application/json' });

async function entryNamed(title: string) {
  const response = await app.inject({ url: '/api/v1/entries?limit=10&content=true', headers });
  const list = response.json<{
    entries: { id: number; title: string; content: string; fullContent?: string | null }[];
  }>();
  const found = list.entries.find((e) => e.title === title);
  if (!found) throw new Error(`No entry ${title}`);
  return found;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, fetcher, { queue });
  alice = (await services.users.create('alice', 'alice password')).id;
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password' },
  });
  headers = {
    cookie: `rss_session=${login.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
  };
  await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers,
    payload: { url: 'https://a.example/rss' },
  });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('full text', () => {
  it('extracts the article from a page, sanitised, with absolute links', () => {
    const content = extractArticle(article('Body'), 'https://a.example/post');
    expect(content).toContain('Body with <a href="https://a.example/more"');
    expect(content).toContain('src="https://a.example/pic.png"');
    expect(content).not.toMatch(/script|Footer|Contact/);
    expect(
      extractArticle('<html><body><script>x()</script></body></html>', 'https://a.example/'),
    ).toBeNull();
  });

  it('extracts on demand, keeping the original content', async () => {
    const one = await entryNamed('One');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/entries/${String(one.id)}/full-text`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ content: string }>().content).toContain('First story text');
    const again = await entryNamed('One');
    expect(again.content).toContain('Short summary');
    expect(again.fullContent).toContain('First story text');

    const two = await entryNamed('Two');
    const notHtml = await app.inject({
      method: 'POST',
      url: `/api/v1/entries/${String(two.id)}/full-text`,
      headers,
    });
    expect(notHtml.statusCode).toBe(422);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/entries/${String((await entryNamed('Three')).id)}/full-text`,
      headers,
    });
    expect(missing.statusCode).toBe(502);
    const others = await app.inject({
      method: 'POST',
      url: '/api/v1/entries/999999/full-text',
      headers,
    });
    expect(others.statusCode).toBe(404);
  });

  it('queues extraction for opted-in feeds and records each result', async () => {
    const [subscription] = await services.feeds.subscriptions.list(alice);
    const id = subscription?.subscription.id ?? 0;
    const sourceId = subscription?.source.id ?? 0;
    queue.jobs.length = 0;
    await services.feeds.fullText.queueFor(sourceId);
    expect(queue.jobs).toEqual([]);

    const turnedOn = await app.inject({
      method: 'PATCH',
      url: `/api/v1/subscriptions/${String(id)}`,
      headers,
      payload: { fullText: true },
    });
    expect(turnedOn.json()).toMatchObject({ fullText: true });
    expect(queue.jobs).toEqual([
      {
        name: 'entry.extract',
        data: { feedSourceId: sourceId },
        key: `extract:${String(sourceId)}`,
      },
    ]);

    await db
      .update(entries)
      .set({ fullContent: null, fullContentAt: null, fullContentError: null });
    await services.feeds.fullText.runJob({ feedSourceId: sourceId });
    const rows = new Map((await db.select().from(entries)).map((e) => [e.title, e]));
    expect(rows.get('One')).toMatchObject({ fullContentError: null });
    expect(rows.get('One')?.fullContent).toContain('First story text');
    expect(rows.get('Two')).toMatchObject({
      fullContent: null,
      fullContentError: 'The article is not a web page',
    });
    expect(rows.get('Three')?.fullContentError).toMatch(/404/);
    for (const row of rows.values()) expect(row.fullContentAt).toBeInstanceOf(Date);

    // A second run finds nothing left to try.
    fetcher.requested.length = 0;
    await services.feeds.fullText.runJob({ feedSourceId: sourceId });
    expect(fetcher.requested).toEqual([]);
    const [entry] = await db.select().from(entries).where(eq(entries.title, 'One'));
    expect(entry?.content).toContain('Short summary');
  });

  it('gives compatibility clients the full text of opted-in feeds', async () => {
    const { password } = await services.appPasswords.create(alice, 'Phone');
    const token = await readerLogin(app, 'alice', password);
    const response = await reader(app, 'GET', '/reader/api/0/stream/contents', { token });
    const items = response.json<{ items: { title: string; summary: { content: string } }[] }>()
      .items;
    expect(items.find((i) => i.title === 'One')?.summary.content).toContain('First story text');
    expect(items.find((i) => i.title === 'Two')?.summary.content).toContain('Short');
  });
});
