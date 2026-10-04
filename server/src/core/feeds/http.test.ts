import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, HttpFetcher } from './http.ts';

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
    if (path === '/to-private') return res.writeHead(301, { location: 'http://10.0.0.1/x' }).end();
    if (path === '/big') return res.writeHead(200).end('x'.repeat(2048));
    if (path === '/busy') return res.writeHead(429, { 'retry-after': '120' }).end();
    if (path === '/slow') return void setTimeout(() => res.writeHead(200).end('late'), 2000);
    res.writeHead(404).end();
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
    expect(seenHeaders.at(-1)?.['user-agent']).toMatch(/rss-reader/);
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

  it('blocks private addresses by default, including via DNS and redirects', async () => {
    const fetcher = new HttpFetcher();
    expect(await failure(fetcher.fetch(`${base}/feed`))).toMatchObject({ code: 'blocked_address' });
    expect(await failure(fetcher.fetch('http://[::1]/'))).toMatchObject({
      code: 'blocked_address',
    });
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
});
