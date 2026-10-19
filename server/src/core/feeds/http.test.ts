import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, HttpFetcher, parseMaxAge } from './http.ts';

let server: Server;
let base: string;
const seenHeaders: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    const path = req.url ?? '/';
    if (path === '/feed') {
      if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
      return res
        .writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' })
        .end('<rss/>');
    }
    if (path === '/gzip') {
      return res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('compressed'));
    }
    if (path.startsWith('/hop/')) {
      const n = Number(path.slice(5));
      return res.writeHead(302, { location: n > 0 ? `/hop/${String(n - 1)}` : '/feed' }).end();
    }
    if (path === '/moved') return res.writeHead(301, { location: '/moved-again' }).end();
    if (path === '/moved-again') return res.writeHead(308, { location: '/hop/0' }).end();
    if (path === '/cached') {
      return res.writeHead(200, { 'cache-control': 'public, max-age=3600' }).end('<rss/>');
    }
    if (path === '/to-private') return res.writeHead(301, { location: 'http://10.0.0.1/x' }).end();
    if (path === '/big') return res.writeHead(200).end('x'.repeat(2048));
    if (path === '/busy') return res.writeHead(429, { 'retry-after': '120' }).end();
    if (path === '/slow') return void setTimeout(() => res.writeHead(200).end('late'), 2000);
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Gone fishing</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

const local = (options = {}) =>
  new HttpFetcher({ allowPrivateNetworks: ['127.0.0.0/8'], ...options });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err as FetchError,
  );

describe('HttpFetcher', () => {
  it('fetches with conditional headers and reports 304', async () => {
    const fetcher = local();
    const fresh = await fetcher.fetch(`${base}/feed`);
    expect(fresh).toMatchObject({ status: 200, etag: '"v1"', contentType: 'application/rss+xml' });
    expect(new TextDecoder().decode(fresh.body)).toBe('<rss/>');
    expect(seenHeaders.at(-1)?.['user-agent']).toMatch(/^Newses \(\+https:\/\/newses\.app\)$/);
    expect(await fetcher.fetch(`${base}/feed`, { etag: '"v1"' })).toMatchObject({
      notModified: true,
      status: 304,
    });
  });

  it('decompresses responses', async () => {
    expect(new TextDecoder().decode((await local().fetch(`${base}/gzip`)).body)).toBe('compressed');
  });

  it('follows redirects up to the limit and reports the final URL', async () => {
    expect((await local().fetch(`${base}/hop/2`)).url).toBe(`${base}/feed`);
    expect(await failure(local({ maxRedirects: 2 }).fetch(`${base}/hop/5`))).toMatchObject({
      code: 'too_many_redirects',
    });
  });

  it('reports the URL reached through leading permanent redirects', async () => {
    expect(await local().fetch(`${base}/moved`)).toMatchObject({
      url: `${base}/feed`,
      permanentUrl: `${base}/hop/0`,
    });
    expect((await local().fetch(`${base}/hop/1`)).permanentUrl).toBeNull();
    expect((await local().fetch(`${base}/feed`)).permanentUrl).toBeNull();
  });

  it('reports declared freshness', async () => {
    expect((await local().fetch(`${base}/cached`)).maxAgeSeconds).toBe(3600);
    expect((await local().fetch(`${base}/feed`)).maxAgeSeconds).toBeNull();
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
    expect(parseMaxAge('no-cache, max-age=60', headers({}))).toBeNull();
    expect(
      parseMaxAge(
        null,
        headers({
          date: 'Sun, 04 Oct 2026 10:00:00 GMT',
          expires: 'Sun, 04 Oct 2026 11:00:00 GMT',
        }),
      ),
    ).toBe(3600);
  });

  it('blocks private addresses by default, including via DNS and redirects', async () => {
    const fetcher = new HttpFetcher();
    expect(await failure(fetcher.fetch(`${base}/feed`))).toMatchObject({ code: 'blocked_address' });
    for (const url of [
      'http://[::1]/',
      'http://203.0.113.5/',
      'http://[::7f00:1]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[2002:7f00:1::]/',
    ]) {
      expect(await failure(fetcher.fetch(url))).toMatchObject({ code: 'blocked_address' });
    }
    const port = new URL(base).port;
    expect(await failure(fetcher.fetch(`http://localhost:${port}/feed`))).toMatchObject({
      code: 'blocked_address',
    });
    expect(await failure(local().fetch(`${base}/to-private`))).toMatchObject({
      code: 'blocked_address',
    });
  });

  it('enforces size limits and timeouts', async () => {
    expect(await failure(local({ maxBytes: 1024 }).fetch(`${base}/big`))).toMatchObject({
      code: 'too_large',
    });
    expect(await failure(local().fetch(`${base}/big`, { maxBytes: 100 }))).toMatchObject({
      code: 'too_large',
    });
    const head = await local().fetch(`${base}/big`, { maxBytes: 100, truncate: true });
    expect(head.body.byteLength).toBe(100);
    expect(await failure(local({ timeoutMs: 200 }).fetch(`${base}/slow`))).toMatchObject({
      code: 'timeout',
    });
  });

  it('reports HTTP errors with Retry-After', async () => {
    expect(await failure(local().fetch(`${base}/busy`))).toMatchObject({
      code: 'http_status',
      status: 429,
      retryAfterSeconds: 120,
    });
    expect(await failure(local().fetch('ftp://example.com/'))).toMatchObject({
      code: 'invalid_url',
    });
  });

  it('answers HTTP errors with their headers and body when asked, but never a 429', async () => {
    const missing = await local().fetch(`${base}/nothing`, { anyStatus: true });
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toBe('text/html');
    expect(new TextDecoder().decode(missing.body)).toBe('<h1>Gone fishing</h1>');
    expect(await failure(local().fetch(`${base}/busy`, { anyStatus: true }))).toMatchObject({
      status: 429,
      url: `${base}/busy`,
    });
  });
});
