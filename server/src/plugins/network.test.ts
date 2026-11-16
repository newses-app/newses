import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { FetchError } from '../core/feeds/http.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import { PluginNetwork } from './network.ts';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let origin: string;
let received: Received[];
let respond: (path: string) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Never answers. */
  hang?: boolean;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const answer = respond(req.url ?? '/');
      if (answer.hang) return;
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Runs requests directly, remembering their hosts and what pause each result asked for. */
const politeFake = () => {
  const fake = {
    hosts: [] as string[],
    pauses: [] as (number | null)[],
    /** Refuses the next request with this, as for a paused host. */
    refuse: null as Error | null,
    async request<T>(host: string, send: () => Promise<T>, pauseFor: (r: T) => number | null) {
      fake.hosts.push(host);
      if (fake.refuse) throw fake.refuse;
      const result = await send();
      fake.pauses.push(pauseFor(result));
      return result;
    },
  };
  return fake;
};

let polite: ReturnType<typeof politeFake>;
let ops: { recordFetch: Mock<OpsRecorder['recordFetch']> };

const network = (allowPrivateNetworks: boolean) =>
  new PluginNetwork({ polite, ops, allowPrivateNetworks, userAgent: 'Newses/test' });

const approved = (host: string) => host === '127.0.0.1';
const never = new AbortController().signal;

beforeEach(() => {
  received = [];
  respond = () => ({ status: 200, headers: { 'content-length': '2' }, body: 'ok' });
  polite = politeFake();
  ops = { recordFetch: vi.fn<OpsRecorder['recordFetch']>() };
});

describe('PluginNetwork', () => {
  it('sends requests to approved hosts through the polite fetcher, with the user agent', async () => {
    const fetch = network(true).fetchFor('webhook', approved, never);
    const response = await fetch(`${origin}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: '{"event":"published.changed"}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(received).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/build',
        body: '{"event":"published.changed"}',
      }),
    ]);
    expect(received[0]?.headers).toMatchObject({
      'user-agent': 'Newses/test',
      authorization: 'Bearer t',
      'content-type': 'application/json',
    });
    expect(polite.hosts).toEqual(['127.0.0.1']);
    expect(ops.recordFetch).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', purpose: 'plugin', outcome: 'ok', bytes: 2 }),
    );
  });

  it('takes a Request, and keeps a user agent the plugin set', async () => {
    const fetch = network(true).fetchFor('webhook', approved, never);
    await fetch(
      new Request(`${origin}/r`, {
        method: 'PUT',
        headers: { 'user-agent': 'my-plugin/1' },
        body: 'payload',
      }),
    );
    expect(received[0]).toMatchObject({ method: 'PUT', url: '/r', body: 'payload' });
    expect(received[0]?.headers['user-agent']).toBe('my-plugin/1');
  });

  it('refuses hosts not approved for the plugin, and other schemes, before any request', async () => {
    const fetch = network(true).fetchFor('webhook', () => false, never);
    await expect(fetch(`${origin}/x`)).rejects.toThrow(
      new TypeError('127.0.0.1 is not approved for the plugin webhook'),
    );
    const anyHost = network(true).fetchFor('webhook', () => true, never);
    await expect(anyHost('file:///etc/passwd')).rejects.toThrow(TypeError);
    expect(received).toEqual([]);
    expect(polite.hosts).toEqual([]);
  });

  it('refuses private addresses unless the operator allows them', async () => {
    const fetch = network(false).fetchFor('webhook', approved, never);
    await expect(fetch(`${origin}/x`)).rejects.toThrow('127.0.0.1 is a private address');
    const byName = network(false).fetchFor('webhook', (host) => host === 'localhost', never);
    const port = new URL(origin).port;
    const failure = await byName(`http://localhost:${port}/x`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toBeInstanceOf(FetchError);
    expect(received).toEqual([]);
    expect(ops.recordFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: 'localhost', outcome: 'blocked' }),
    );
  });

  it('returns redirects instead of following them', async () => {
    respond = (path) =>
      path === '/go'
        ? { status: 302, headers: { location: 'http://elsewhere.example/' } }
        : { status: 200 };
    const fetch = network(true).fetchFor('webhook', approved, never);
    const response = await fetch(`${origin}/go`);
    expect(response.status).toBe(302);
    expect(received.map((r) => r.url)).toEqual(['/go']);
  });

  it('pauses the host when it answers 429, or 503 with Retry-After', async () => {
    const answers: Record<string, { status: number; headers?: Record<string, string> }> = {
      '/a': { status: 429, headers: { 'retry-after': '120' } },
      '/b': { status: 429 },
      '/c': { status: 503, headers: { 'retry-after': '30' } },
      '/d': { status: 503 },
      '/e': { status: 500 },
    };
    respond = (path) => answers[path] ?? { status: 200 };
    const fetch = network(true).fetchFor('webhook', approved, never);
    for (const path of Object.keys(answers)) await fetch(`${origin}${path}`);
    expect(polite.pauses).toEqual([120, 600, 30, null, null]);
    expect(
      ops.recordFetch.mock.calls.map(([call]) => (call as { outcome: string }).outcome),
    ).toEqual(['rate_limited', 'rate_limited', 'server_error', 'server_error', 'server_error']);
  });

  it('turns a paused host into a TypeError', async () => {
    polite.refuse = new FetchError('host_blocked', 'paused', { retryAfterSeconds: 60 });
    const fetch = network(true).fetchFor('webhook', approved, never);
    const failure = await fetch(`${origin}/x`).catch((err: unknown) => err);
    expect(failure).toEqual(new TypeError('127.0.0.1 asked to wait before more requests'));
    expect(received).toEqual([]);
  });

  it("ends requests when the hook's signal aborts", async () => {
    const controller = new AbortController();
    respond = () => ({ status: 200, hang: true });
    server.once('request', () => {
      controller.abort(new DOMException('time is up', 'TimeoutError'));
    });
    const fetch = network(true).fetchFor('webhook', approved, controller.signal);
    await expect(fetch(`${origin}/slow`)).rejects.toThrow();
    expect(ops.recordFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'timeout' }),
    );
  });
});
