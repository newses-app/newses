import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

const fetcher = new FakeFetcher().set('https://food.example/rss', {
  body: rss('Food', 'https://food.example/', [
    {
      guid: '1',
      // Stored as `Fish & <Chips>`, which pages and feeds must escape.
      title: 'Fish &amp;amp; &amp;lt;Chips&amp;gt;',
      link: 'https://food.example/fish',
      description: '<p>Crispy</p><img src="https://img.example/fish.png">',
      pubDate: 'Sat, 03 Oct 2026 10:00:00 GMT',
    },
    { guid: '2', title: 'Soup', description: 'Hot', pubDate: 'Sun, 04 Oct 2026 10:00:00 GMT' },
  ]),
});

let database: TestDatabase;
let services: ApiServices;
let app: ReturnType<typeof buildApp>;
let alice: { id: number; headers: Record<string, string> };
let bob: { id: number; headers: Record<string, string> };
let fish: number;
let soup: number;

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

beforeAll(async () => {
  database = await createTestDatabase();
  services = createTestServices(createDb(database.pool), fetcher);
  app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services,
    publicUrl: 'https://reader.example',
  });
  alice = await signIn('alice');
  bob = await signIn('bob');
  await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers: alice.headers,
    payload: { url: 'https://food.example/rss' },
  });
  const list = await app.inject({ url: '/api/v1/entries', headers: alice.headers });
  const entries = list.json<{ entries: { id: number; title: string }[] }>().entries;
  fish = entries.find((e) => e.title.startsWith('Fish'))?.id ?? 0;
  soup = entries.find((e) => e.title === 'Soup')?.id ?? 0;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('share links', () => {
  it('shares an entry as a public page until the link is revoked', async () => {
    const share = await app.inject({
      method: 'PUT',
      url: `/api/v1/entries/${String(fish)}/share`,
      headers: alice.headers,
    });
    const { shareId } = share.json<{ shareId: string }>();
    const again = await app.inject({
      method: 'PUT',
      url: `/api/v1/entries/${String(fish)}/share`,
      headers: alice.headers,
    });
    expect(again.json()).toEqual({ shareId });
    const shares = await app.inject({ url: '/api/v1/shares', headers: alice.headers });
    expect(shares.json<{ id: number; shareId: string }[]>()).toMatchObject([{ id: fish, shareId }]);

    const page = await app.inject({ url: `/public/share/${shareId}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).not.toContain('script-src');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect(page.body).toContain('<title>Fish &amp; &lt;Chips&gt;</title>');
    expect(page.body).toContain('<p>Crispy</p>');
    expect(page.body).toContain('href="https://food.example/fish"');
    expect(page.body).toContain('src="https://img.example/fish.png"');

    await services.prefs.update(alice.id, { proxyImages: true });
    const proxied = await app.inject({ url: `/public/share/${shareId}` });
    expect(proxied.body).toMatch(/src="\/api\/v1\/images\/[^"]+"/);
    await services.prefs.update(alice.id, { proxyImages: false });

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/entries/${String(fish)}/share`,
      headers: alice.headers,
    });
    expect(revoked.statusCode).toBe(204);
    const gone = await app.inject({ url: `/public/share/${shareId}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await app.inject({ url: '/public/share/not-a-uuid' })).statusCode).toBe(404);
  });

  it('shares only the owner’s entries and hides those of disabled users', async () => {
    const theirs = await app.inject({
      method: 'PUT',
      url: `/api/v1/entries/${String(soup)}/share`,
      headers: bob.headers,
    });
    expect(theirs.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/shares' })).statusCode).toBe(401);

    const share = await app.inject({
      method: 'PUT',
      url: `/api/v1/entries/${String(soup)}/share`,
      headers: alice.headers,
    });
    const { shareId } = share.json<{ shareId: string }>();
    await services.users.update(alice.id, { disabled: true });
    expect((await app.inject({ url: `/public/share/${shareId}` })).statusCode).toBe(404);
    await services.users.update(alice.id, { disabled: false });
    alice = { ...alice, ...(await reSignIn('alice')) };
    expect((await app.inject({ url: `/public/share/${shareId}` })).statusCode).toBe(200);
  });
});

async function reSignIn(login: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: `${login} password` },
  });
  return {
    headers: {
      cookie: `rss_session=${res.cookies.find((c) => c.name === 'rss_session')?.value ?? ''}`,
      'x-csrf-token': res.json<{ csrfToken: string }>().csrfToken,
    },
  };
}

describe('published feed', () => {
  it('serves published entries as RSS at a secret, regenerable URL', async () => {
    const keyRes = await app.inject({ url: '/api/v1/published-feed', headers: alice.headers });
    const { key } = keyRes.json<{ key: string }>();
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(
      (await app.inject({ url: '/api/v1/published-feed', headers: alice.headers })).json(),
    ).toEqual({ key });

    const empty = await app.inject({ url: `/public/feeds/${key}` });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(empty.body).not.toContain('<item>');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/entries/${String(fish)}`,
      headers: alice.headers,
      payload: { published: true },
    });
    const feed = await app.inject({ url: `/public/feeds/${key}` });
    expect(feed.body).toContain('<title>Published articles</title>');
    expect(feed.body).toContain(`href="https://reader.example/public/feeds/${key}"`);
    expect(feed.body.match(/<item>/g)).toHaveLength(1);
    expect(feed.body).toContain('<![CDATA[Fish & <Chips>]]>');
    expect(feed.body).toContain('<link>https://food.example/fish</link>');

    const etag = feed.headers.etag;
    expect(etag).toMatch(/^W\/"/);
    const unchanged = await app.inject({
      url: `/public/feeds/${key}`,
      headers: { 'if-none-match': String(etag) },
    });
    expect(unchanged.statusCode).toBe(304);

    await services.prefs.update(alice.id, { proxyImages: true });
    const proxied = await app.inject({ url: `/public/feeds/${key}` });
    expect(proxied.body).toContain('https://reader.example/api/v1/images/');
    expect(proxied.headers.etag).not.toBe(etag);
    await services.prefs.update(alice.id, { proxyImages: false });

    const regenerated = await app.inject({
      method: 'POST',
      url: '/api/v1/published-feed/regenerate',
      headers: alice.headers,
    });
    const next = regenerated.json<{ key: string }>().key;
    expect(next).not.toBe(key);
    expect((await app.inject({ url: `/public/feeds/${key}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/public/feeds/${next}` })).statusCode).toBe(200);

    const bobs = await app.inject({ url: '/api/v1/published-feed', headers: bob.headers });
    const bobFeed = await app.inject({
      url: `/public/feeds/${bobs.json<{ key: string }>().key}`,
    });
    expect(bobFeed.body).not.toContain('<item>');

    await services.users.update(alice.id, { disabled: true });
    expect((await app.inject({ url: `/public/feeds/${next}` })).statusCode).toBe(404);
    await services.users.update(alice.id, { disabled: false });
  });
});

describe('legacy TTRSS public URLs', () => {
  it('redirect the published feed and share links to their pages here', async () => {
    const feed = await app.inject({ url: '/public.php?op=rss&id=-2&key=abc_D-1&view-mode=all' });
    expect(feed.statusCode).toBe(301);
    expect(feed.headers.location).toBe('/public/feeds/abc_D-1');
    const uuid = '0F8FAD5B-D9CB-469F-A165-70867728950E';
    const share = await app.inject({ url: `/public.php?op=share&key=${uuid}` });
    expect(share.statusCode).toBe(301);
    expect(share.headers.location).toBe(`/public/share/${uuid.toLowerCase()}`);
    for (const url of [
      '/public.php?op=rss&id=12&key=abc',
      '/public.php?op=share&key=not-a-uuid',
      '/public.php?op=login',
      '/public.php',
    ])
      expect((await app.inject({ url })).statusCode).toBe(404);
  });
});
