import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (url, init = {}) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init });
    return Promise.resolve(responses.shift() ?? new Response(null, { status: 204 }));
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const header = (call: Call | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

describe('createApiClient', () => {
  it('sends the CSRF token from login on unsafe cookie requests only', async () => {
    const { calls, fetch } = fakeFetch([
      json({ user: {}, csrfToken: 'csrf-1' }),
      json({ entries: [], cursor: null, view: 'all' }),
      json({ updated: 1 }),
    ]);
    const api = createApiClient({ baseUrl: 'https://reader.example/', fetch });
    await api.auth.login({ login: 'a', password: 'b' });
    await api.entries.list({ special: 'starred', q: 'x y', limit: 10, content: undefined });
    await api.entries.markRead({ special: 'all' });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'https://reader.example/api/v1/auth/login'],
      ['GET', 'https://reader.example/api/v1/entries?special=starred&q=x+y&limit=10'],
      ['POST', 'https://reader.example/api/v1/entries/mark-read'],
    ]);
    expect(header(calls[1], 'x-csrf-token')).toBeUndefined();
    expect(header(calls[2], 'x-csrf-token')).toBe('csrf-1');
    expect(calls[2]?.init.credentials).toBe('include');
  });

  it('names the calling app, when given one', async () => {
    const { calls, fetch } = fakeFetch([json([]), json([])]);
    await createApiClient({ client: 'desktop', fetch }).admin.ops.alerts();
    await createApiClient({ fetch }).admin.ops.alerts();
    expect(calls[0]?.url).toBe('/api/v1/admin/ops/alerts');
    expect(header(calls[0], 'x-rss-client')).toBe('desktop');
    expect(header(calls[1], 'x-rss-client')).toBeUndefined();
  });

  it('uses a bearer token when given one', async () => {
    const { calls, fetch } = fakeFetch([json({ all: 0 })]);
    await createApiClient({ token: 't0k', fetch }).counters();
    expect(calls[0]?.url).toBe('/api/v1/counters');
    expect(header(calls[0], 'authorization')).toBe('Bearer t0k');
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('reads a changing server and token on each request, never sending cookies', async () => {
    const { calls, fetch } = fakeFetch([json({ all: 0 }), json({ all: 0 }), json({})]);
    let server = 'https://one.example';
    let token: string | null = null;
    const api = createApiClient({ baseUrl: () => server, token: () => token, fetch });
    await api.counters();
    server = 'https://two.example/';
    token = 't1';
    await api.counters();
    expect(calls.map((c) => c.url)).toEqual([
      'https://one.example/api/v1/counters',
      'https://two.example/api/v1/counters',
    ]);
    expect(header(calls[0], 'authorization')).toBeUndefined();
    expect(header(calls[1], 'authorization')).toBe('Bearer t1');
    expect(calls.map((c) => c.init.credentials)).toEqual(['omit', 'omit']);
    expect(api.eventsUrl).toBe('https://two.example/api/v1/events');
  });

  it('raises ApiError with the API error code and Retry-After', async () => {
    const { fetch } = fakeFetch([
      new Response(JSON.stringify({ error: 'throttled', message: 'Wait' }), {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    ]);
    const error = await createApiClient({ fetch })
      .subscriptions.refresh(1)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'throttled', retryAfterSeconds: 30 });
  });

  it('posts OPML as XML and returns exports as text', async () => {
    const { calls, fetch } = fakeFetch([json({ subscribed: 1 }), new Response('<opml/>')]);
    const api = createApiClient({ fetch });
    await api.opml.import('<opml/>');
    expect(header(calls[0], 'content-type')).toBe('text/x-opml');
    expect(calls[0]?.init.body).toBe('<opml/>');
    expect(await api.opml.export()).toBe('<opml/>');
  });
});
