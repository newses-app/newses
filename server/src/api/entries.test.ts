import type { AddressInfo } from 'node:net';
import { createApiClient } from '@rss-reader/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { RecordingRealtime } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let headers: Record<string, string>;
let token: string;
const realtime = new RecordingRealtime();
const fetcher = new FakeFetcher().set('https://news.example/rss', {
  body: rss('News', 'https://news.example/', [
    {
      guid: '1',
      title: 'First story',
      description: 'About kittens',
      pubDate: 'Sat, 03 Oct 2026 10:00:00 GMT',
    },
    {
      guid: '2',
      title: 'Second story',
      description: 'About puppies',
      pubDate: 'Sun, 04 Oct 2026 10:00:00 GMT',
    },
  ]),
});

beforeAll(async () => {
  database = await createTestDatabase();
  const services = createTestServices(createDb(database.pool), fetcher, { realtime });
  await services.users.create('alice', 'alice password');
  app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services,
    events: { heartbeatMs: 50, coalesceMs: 20 },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password' },
  });
  const cookie = login.cookies.find((c) => c.name === 'rss_session')?.value ?? '';
  headers = {
    cookie: `rss_session=${cookie}`,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
  };
  const bearer = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'alice', password: 'alice password', tokenType: 'bearer' },
  });
  token = bearer.json<{ token: string }>().token;
  await app.inject({
    method: 'POST',
    url: '/api/v1/subscriptions',
    headers,
    payload: { url: 'https://news.example/rss' },
  });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface EntryList {
  entries: { id: number; title: string; unread: boolean; starred: boolean }[];
  cursor: string | null;
}

describe('entries API', () => {
  it('lists, searches, reads, and updates entries', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries?limit=1', headers });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const page = list.json<EntryList>();
    expect(page.entries.map((e) => e.title)).toEqual(['Second story']);
    const rest = await app.inject({
      method: 'GET',
      url: `/api/v1/entries?limit=1&cursor=${page.cursor ?? ''}`,
      headers,
    });
    expect(rest.json<EntryList>().entries.map((e) => e.title)).toEqual(['First story']);

    const found = await app.inject({ method: 'GET', url: '/api/v1/entries?q=kittens', headers });
    expect(found.json<EntryList>().entries.map((e) => e.title)).toEqual(['First story']);

    const id = page.entries[0]?.id ?? 0;
    const single = await app.inject({
      method: 'GET',
      url: `/api/v1/entries/${String(id)}`,
      headers,
    });
    expect(single.json<{ content: string }>().content).toContain('puppies');

    const starred = await app.inject({
      method: 'PATCH',
      url: `/api/v1/entries/${String(id)}`,
      headers,
      payload: { starred: true, unread: false },
    });
    expect(starred.json()).toMatchObject({ id, starred: true, unread: false });
    expect(starred.json<{ content?: string }>().content).toBeUndefined();

    const bulk = await app.inject({
      method: 'PATCH',
      url: '/api/v1/entries',
      headers,
      payload: { ids: [id], unread: true },
    });
    expect(bulk.json()).toEqual({ updated: 1 });

    const counters = await app.inject({ method: 'GET', url: '/api/v1/counters', headers });
    expect(counters.json<{ special: object }>().special).toEqual({
      all: 2,
      fresh: expect.any(Number) as number,
      starred: 1,
      published: 0,
    });

    const caughtUp = await app.inject({
      method: 'POST',
      url: '/api/v1/entries/mark-read',
      headers,
      payload: { special: 'all' },
    });
    expect(caughtUp.json()).toEqual({ updated: 2 });
  });

  it('validates queries and stream selection', async () => {
    const both = await app.inject({
      method: 'GET',
      url: '/api/v1/entries?subscriptionId=1&special=all',
      headers,
    });
    expect(both.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/entries/999999', headers });
    expect(missing.statusCode).toBe(404);
  });

  it('syncs incrementally', async () => {
    const full = await app.inject({ method: 'GET', url: '/api/v1/sync', headers });
    expect(full.statusCode).toBe(200);
    const body = full.json<{ entries: unknown[]; subscriptions: unknown[]; next: string }>();
    expect(body.entries).toHaveLength(2);
    expect(body.subscriptions).toHaveLength(1);
    const delta = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?since=${body.next}`,
      headers,
    });
    expect(delta.json<{ entries: unknown[] }>().entries).toEqual([]);
  });

  it('reads and updates preferences', async () => {
    const prefs = await app.inject({ method: 'GET', url: '/api/v1/prefs', headers });
    expect(prefs.json()).toMatchObject({ viewMode: 'adaptive', theme: 'system' });
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/prefs',
      headers,
      payload: { theme: 'dark', updateIntervalMinutes: 60 },
    });
    expect(updated.json()).toMatchObject({ theme: 'dark', updateIntervalMinutes: 60 });
    const tooOften = await app.inject({
      method: 'PATCH',
      url: '/api/v1/prefs',
      headers,
      payload: { updateIntervalMinutes: 1 },
    });
    expect(tooOften.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v1/prefs',
      headers,
      payload: { nope: true },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('serves the OpenAPI document', async () => {
    const doc = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(doc.statusCode).toBe(200);
    const spec = doc.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/entries',
        '/api/v1/counters',
        '/api/v1/sync',
        '/api/v1/prefs',
      ]),
    );
  });
});

describe('events stream', () => {
  it('streams coalesced counter events and heartbeats for the signed-in user', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const unauthenticated = await fetch(`http://127.0.0.1:${String(port)}/api/v1/events`);
    expect(unauthenticated.status).toBe(401);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const userId = realtime.published[0]?.userId ?? 1;
    void realtime.publish(userId, { type: 'counters' });
    void realtime.publish(userId, { type: 'counters' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(text.includes('event: counters') && text.includes(':\n\n'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain('retry: 5000');
    expect(text.match(/event: counters/g)).toHaveLength(1);
    expect(text).toContain(':\n\n');
  });

  it('answers 204 without auth where streams are disabled', async () => {
    const noStreams = buildApp({
      logger: pino({ level: 'silent' }),
      healthChecks: {},
      services: createTestServices(createDb(database.pool), fetcher),
      events: false,
    });
    expect((await noStreams.inject({ url: '/api/v1/events' })).statusCode).toBe(204);
    await noStreams.close();
  });

  it('works with the typed client over HTTP', async () => {
    const port = (app.server.address() as AddressInfo).port;
    const api = createApiClient({ baseUrl: `http://127.0.0.1:${String(port)}`, token });
    const [subscription] = await api.subscriptions.list();
    const page = await api.entries.list({ subscriptionId: subscription?.id, limit: 5 });
    expect(page.entries).toHaveLength(2);
    expect((await api.prefs.get()).viewMode).toBe('adaptive');
    await expect(api.entries.get(999_999)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
