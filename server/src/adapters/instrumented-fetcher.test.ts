import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FetchError, HttpFetcher } from '../core/feeds/http.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { recordSpans, spanText } from '../test/tracing.ts';
import { withSpan } from '../telemetry/index.ts';
import { InstrumentedFetcher, outcomeOf } from './instrumented-fetcher.ts';

let tracing: ReturnType<typeof recordSpans>;
let fetches: Parameters<OpsRecorder['recordFetch']>[0][];
const recorder = {
  recordFetch: (fetch: Parameters<OpsRecorder['recordFetch']>[0]) => {
    fetches.push(fetch);
  },
} as unknown as OpsRecorder;

const closable = (fetcher: FakeFetcher) =>
  Object.assign(fetcher, { close: () => Promise.resolve() });

beforeAll(() => {
  tracing = recordSpans();
});

beforeEach(() => {
  tracing.reset();
  fetches = [];
});

afterAll(() => {
  tracing.stop();
});

describe('InstrumentedFetcher', () => {
  it('records the host, never the path or query', async () => {
    const url = 'https://user:pw@feeds.example/private/feed.xml?key=s3cret-token';
    const fetcher = new InstrumentedFetcher(
      closable(new FakeFetcher().set(url, { body: rss('Private') })),
      recorder,
    );
    await fetcher.fetch(url, { purpose: 'feed' });

    const [span] = tracing.spans();
    expect(span?.name).toBe('GET feeds.example');
    expect(span?.attributes).toMatchObject({
      'server.address': 'feeds.example',
      'rss.fetch.purpose': 'feed',
      'rss.fetch.outcome': 'ok',
      'http.response.status_code': 200,
    });
    const text = spanText(tracing.spans());
    for (const secret of ['s3cret', 'private', 'pw@', 'user:']) expect(text).not.toContain(secret);
    expect(fetches).toEqual([
      expect.objectContaining({ host: 'feeds.example', purpose: 'feed', outcome: 'ok' }),
    ]);
  });

  it('records failures with their outcome', async () => {
    const fetcher = new InstrumentedFetcher(
      closable(
        new FakeFetcher().set(
          'https://busy.example/feed',
          new FetchError('http_status', 'HTTP 429', { status: 429, retryAfterSeconds: 60 }),
        ),
      ),
      recorder,
    );
    await expect(fetcher.fetch('https://busy.example/feed', { purpose: 'image' })).rejects.toThrow(
      FetchError,
    );
    expect(tracing.spans()[0]?.attributes).toMatchObject({
      'rss.fetch.outcome': 'rate_limited',
      'rss.fetch.retry_after_seconds': 60,
      'error.type': 'http_status',
    });
    expect(fetches).toEqual([
      expect.objectContaining({ host: 'busy.example', purpose: 'image', outcome: 'rate_limited' }),
    ]);
  });

  it('maps fetch errors to outcomes', () => {
    const status = (code: number, retryAfterSeconds: number | null = null) =>
      outcomeOf(new FetchError('http_status', 'x', { status: code, retryAfterSeconds }));
    expect(status(429)).toBe('rate_limited');
    expect(status(503, 30)).toBe('rate_limited');
    expect(status(503)).toBe('server_error');
    expect(status(404)).toBe('client_error');
    expect(outcomeOf(new FetchError('timeout', 'x'))).toBe('timeout');
    expect(outcomeOf(new FetchError('network', 'x'))).toBe('network');
    expect(outcomeOf(new FetchError('blocked_address', 'x'))).toBe('blocked');
    expect(outcomeOf(new FetchError('too_large', 'x'))).toBe('other');
    expect(outcomeOf(new Error('x'))).toBe('other');
  });
});

describe('requests to remote hosts', () => {
  let server: Server;
  let received: IncomingHttpHeaders[];

  beforeAll(async () => {
    received = [];
    server = createServer((request, response) => {
      received.push(request.headers);
      response.setHeader('content-type', 'application/rss+xml');
      response.end(rss('Local'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('carry no trace context, even inside a trace', async () => {
    const { port } = server.address() as AddressInfo;
    const fetcher = new InstrumentedFetcher(new HttpFetcher({ allowPrivateNetworks: true }), null);
    await withSpan('job feed.fetch', {}, () => fetcher.fetch(`http://127.0.0.1:${String(port)}/`));
    await fetcher.close();

    expect(received).toHaveLength(1);
    expect(Object.keys(received[0] ?? {})).not.toContain('traceparent');
    expect(Object.keys(received[0] ?? {})).not.toContain('tracestate');
    expect(tracing.spans().map((span) => span.name)).toEqual([
      `GET 127.0.0.1:${String(port)}`,
      'job feed.fetch',
    ]);
  });
});
