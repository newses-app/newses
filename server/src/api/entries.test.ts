import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createApiClient } from '@newses/shared';
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
  entries: { id: number; title: string; unread: boolean; starred: boolean; note: string | null }[];
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

  it('scores entries within bounds', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries', headers });
    const id = list.json<EntryList>().entries[0]?.id ?? 0;
    const url = `/api/v1/entries/${String(id)}`;
    const scored = await app.inject({ method: 'PATCH', url, headers, payload: { score: 120 } });
    expect(scored.json()).toMatchObject({ id, score: 120 });
    const bulk = await app.inject({
      method: 'PATCH',
      url: '/api/v1/entries',
      headers,
      payload: { ids: [id], score: -40 },
    });
    expect(bulk.json()).toEqual({ updated: 1 });
    for (const score of [1_000_001, 1.5])
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { score } })).statusCode,
      ).toBe(400);
  });

  it('sets, finds, and clears notes', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries', headers });
    const id = list.json<EntryList>().entries[0]?.id ?? 0;
    const url = `/api/v1/entries/${String(id)}/note`;
    const saved = await app.inject({ method: 'PUT', url, headers, payload: { note: 'llamas' } });
    expect(saved.statusCode).toBe(204);
    const found = await app.inject({ method: 'GET', url: '/api/v1/entries?q=llamas', headers });
    expect(found.json<EntryList>().entries).toMatchObject([{ id, note: 'llamas' }]);
    const tooLong = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { note: 'x'.repeat(10_001) },
    });
    expect(tooLong.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url, headers, payload: { note: null } });
    const single = await app.inject({
      method: 'GET',
      url: `/api/v1/entries/${String(id)}`,
      headers,
    });
    expect(single.json<{ note: string | null }>().note).toBeNull();
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/v1/entries/0/note',
      headers,
      payload: { note: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('tags entries and lists them by tag', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries', headers });
    const id = list.json<EntryList>().entries[0]?.id ?? 0;
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/v1/entries/${String(id)}/tags`,
      headers,
      payload: { tags: ['Long Reads', 'long reads', ' '] },
    });
    expect(saved.json()).toEqual({ tags: ['long reads'] });
    const counts = await app.inject({ method: 'GET', url: '/api/v1/tags', headers });
    expect(counts.json()).toEqual([{ tag: 'long reads', count: 1 }]);
    const tagged = await app.inject({
      method: 'GET',
      url: '/api/v1/entries?tag=long%20reads',
      headers,
    });
    expect(tagged.json<EntryList>().entries.map((e) => e.id)).toEqual([id]);
    const both = await app.inject({
      method: 'GET',
      url: '/api/v1/entries?tag=x&labelId=1',
      headers,
    });
    expect(both.statusCode).toBe(400);
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

    const token = await app.inject({ method: 'GET', url: '/api/v1/sync/token', headers });
    expect(token.statusCode).toBe(200);
    const fromNow = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?since=${token.json<{ next: string }>().next}`,
      headers,
    });
    expect(fromNow.json<{ entries: unknown[] }>().entries).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sync/token' })).statusCode).toBe(401);
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

  it('applies late changes only where nothing changed them since', async () => {
    interface Flags {
      id: number;
      unread: boolean;
      starred: boolean;
      published: boolean;
      score: number;
    }
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries', headers });
    const before = list.json<{ entries: Flags[] }>().entries;
    const [a = 0, b = 0] = before.map((e) => e.id);
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/api/v1/entries', headers, payload });
    await patch({ ids: [a, b], unread: false, starred: false, score: 0 });
    // Another device stars b and scores it, after this client saw both unstarred at 0.
    await patch({ ids: [b], starred: true, score: 9 });

    const late = await patch({
      ids: [a, b],
      starred: true,
      score: 5,
      expect: { starred: false, score: 0 },
    });
    expect(late.json()).toEqual({
      updated: 1,
      conflicts: [{ id: b, current: { unread: false, starred: true, published: false, score: 9 } }],
    });
    const single = await app.inject({
      method: 'PATCH',
      url: `/api/v1/entries/${String(b)}`,
      headers,
      payload: { score: 1, expect: { score: 0 } },
    });
    expect(single.json()).toMatchObject({ id: b, starred: true, score: 9 });
    const now = await app.inject({ method: 'GET', url: `/api/v1/entries/${String(a)}`, headers });
    expect(now.json()).toMatchObject({ starred: true, score: 5 });

    for (const { id, ...flags } of before)
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/entries/${String(id)}`,
        headers,
        payload: flags,
      });
  });

  it('keeps notes changed elsewhere, and merges label and tag changes', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entries', headers });
    const id = list.json<EntryList>().entries[0]?.id ?? 0;
    const note = (payload: object) =>
      app.inject({ method: 'PUT', url: `/api/v1/entries/${String(id)}/note`, headers, payload });
    await note({ note: 'theirs' });
    expect((await note({ note: 'mine', expected: null })).json()).toMatchObject({
      error: 'conflict',
    });
    expect((await note({ note: 'mine', expected: ' theirs ' })).statusCode).toBe(204);
    expect((await note({ note: 'mine', expected: 'older' })).statusCode).toBe(204);
    await note({ note: null });

    const tags = (method: 'PUT' | 'PATCH', payload: object) =>
      app.inject({ method, url: `/api/v1/entries/${String(id)}/tags`, headers, payload });
    await tags('PUT', { tags: ['a', 'b'] });
    expect((await tags('PATCH', { add: ['C'], remove: ['A'] })).json()).toEqual({
      tags: ['b', 'c'],
    });
    await tags('PUT', { tags: [] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/labels',
      headers,
      payload: { caption: 'Merge', fgColor: '#000000', bgColor: '#ffffff' },
    });
    const label = created.json<{ id: number }>().id;
    const labels = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/entries/${String(id)}/labels`,
        headers,
        payload,
      });
    expect((await labels({ add: [label, 999_999] })).json()).toEqual({ labelIds: [label] });
    expect((await labels({ remove: [label] })).json()).toEqual({ labelIds: [] });
    expect((await labels({ add: [label] })).json()).toEqual({ labelIds: [label] });
    await app.inject({ method: 'DELETE', url: `/api/v1/labels/${String(label)}`, headers });
  });

  it('compresses JSON for clients that accept it, and leaves small answers plain', async () => {
    // Over the 1 KB threshold.
    const url = '/api/v1/openapi.json';
    const plain = await app.inject({ method: 'GET', url, headers });
    expect(plain.rawPayload.length).toBeGreaterThan(1024);
    expect(plain.headers['content-encoding']).toBeUndefined();
    for (const encoding of ['br', 'gzip'] as const) {
      const packed = await app.inject({
        method: 'GET',
        url,
        headers: { ...headers, 'accept-encoding': encoding },
      });
      expect(packed.headers['content-encoding']).toBe(encoding);
      expect(packed.headers.vary).toMatch(/accept-encoding/i);
      const body =
        encoding === 'br' ? brotliDecompressSync(packed.rawPayload) : gunzipSync(packed.rawPayload);
      expect(JSON.parse(body.toString())).toEqual(plain.json());
    }
    const small = await app.inject({
      method: 'GET',
      url: '/api/v1/server',
      headers: { 'accept-encoding': 'br' },
    });
    expect(small.headers['content-encoding']).toBeUndefined();
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
        '/api/v1/sync/token',
        '/api/v1/entries/contents',
        '/api/v1/prefs',
        '/api/v1/themes',
        '/api/v1/archive/entries',
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
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'app://newses',
        'accept-encoding': 'br, gzip',
      },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    // Compressing would buffer the stream.
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBe('app://newses');
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
