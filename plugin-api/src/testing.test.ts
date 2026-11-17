import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePlugin, secret, STORAGE_LIMITS } from './index.ts';
import {
  createTestContext,
  fixtureDigestEntry,
  fixtureEntry,
  fixtureEntryWithText,
  MemoryStore,
  runHook,
} from './testing.ts';

describe('MemoryStore', () => {
  it('keeps JSON values by key, lists them in key order, and forgets them when they expire', async () => {
    let now = 0;
    const store = new MemoryStore({ now: () => now });
    await store.set('b', { n: 1 });
    await store.set('a:1', [1, 2]);
    await store.set('a:2', 'two', { ttlSeconds: 60 });
    expect(await store.get('b')).toEqual({ n: 1 });
    expect(await store.list('a:')).toEqual([
      { key: 'a:1', value: [1, 2] },
      { key: 'a:2', value: 'two' },
    ]);
    expect(await store.list('', { after: 'a:2', limit: 5 })).toEqual([
      { key: 'b', value: { n: 1 } },
    ]);
    now = 60_000;
    expect(await store.get('a:2')).toBeUndefined();
    expect(await store.delete('b')).toBe(true);
    expect(await store.delete('b')).toBe(false);
  });

  it("refuses what the server's stores refuse", async () => {
    const store = new MemoryStore();
    await expect(store.set('', 1)).rejects.toThrow(TypeError);
    await expect(store.set('x'.repeat(STORAGE_LIMITS.keyLength + 1), 1)).rejects.toThrow(TypeError);
    await expect(store.set('fn', () => 1)).rejects.toThrow('Stored values must be JSON');
    await expect(store.set('big', 'x'.repeat(STORAGE_LIMITS.valueBytes))).rejects.toThrow(
      RangeError,
    );
    await expect(store.set('ttl', 1, { ttlSeconds: 0 })).rejects.toThrow('ttlSeconds');
  });
});

describe('createTestContext', () => {
  it('logs, and fetches approved hosts only, without following redirects', async () => {
    const requests: Request[] = [];
    const context = createTestContext({
      settings: { region: 'eu' },
      hosts: ['hooks.example'],
      fetch: (input) => {
        requests.push(input as Request);
        return Promise.resolve(new Response('ok'));
      },
    });
    context.logger.info('sent', { status: 200 });
    expect(context.logs).toEqual([{ level: 'info', message: 'sent', fields: { status: 200 } }]);
    expect(context.settings).toEqual({ region: 'eu' });
    expect(
      await (await context.fetch('https://hooks.example/build', { method: 'POST' })).text(),
    ).toBe('ok');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.redirect).toBe('manual');
    await expect(context.fetch('https://other.example/')).rejects.toThrow(TypeError);
    await expect(context.fetch('file:///etc/passwd')).rejects.toThrow(TypeError);
    await expect(
      createTestContext({ hosts: ['hooks.example'] }).fetch('https://hooks.example/'),
    ).rejects.toThrow('no fetch');
    expect(createTestContext({ userStorage: null }).userStorage).toBeNull();
  });
});

describe('fixtures', () => {
  it('make entries with distinct ids, overridable', () => {
    const [a, b] = [fixtureEntry(), fixtureEntry({ title: 'Mine', published: true })];
    expect(a.id).not.toBe(b.id);
    expect(b).toMatchObject({ title: 'Mine', published: true, unread: true });
    expect(fixtureEntryWithText({ text: 'Body' })).toMatchObject({ text: 'Body' });
    expect(fixtureDigestEntry({ id: 7 })).toMatchObject({ id: 7, contentHash: 'hash-7' });
  });
});

describe('runHook', () => {
  const plugin = definePlugin({
    id: 'echo',
    version: '1.0.0',
    apiVersion: '^0.1',
    scopes: ['instance', 'user'],
    hosts: ['hooks.example'],
    settings: {
      instance: z.object({ key: secret(), region: z.string().default('eu') }),
      user: z.object({ greeting: z.string().default('Hello') }),
    },
    hooks: {
      'published.changed': {
        debounceSeconds: 120,
        run: async (event, context) => {
          await context.userStorage?.set('last', event.published.length);
          context.logger.info('changed', { region: context.settings.region });
        },
      },
      'digest.compose': {
        run: (input, context) => ({
          overview: `${String(context.userSettings?.greeting)}: ${String(input.entries.length)} new`,
          entries: input.entries.map((entry) => ({ id: entry.id, text: entry.title })),
        }),
      },
    },
  });

  it('runs a hook with its settings parsed and a context of its own', async () => {
    const event = { userId: 1, feedUrl: null, published: [fixtureEntry()], unpublished: [] };
    const { context } = await runHook(plugin, 'published.changed', event, {
      settings: { key: 'k' },
    });
    expect(context.logs).toEqual([{ level: 'info', message: 'changed', fields: { region: 'eu' } }]);
    expect(await context.userStorage?.get('last')).toBe(1);
    const entries = [fixtureDigestEntry({ id: 3, title: 'Three' })];
    const { value } = await runHook(
      plugin,
      'digest.compose',
      { userId: 1, language: 'en', frequency: 'daily', entries, more: 0 },
      { settings: { key: 'k' }, userSettings: { greeting: 'Hi' } },
    );
    expect(value).toEqual({ overview: 'Hi: 1 new', entries: [{ id: 3, text: 'Three' }] });
  });

  it('fails as the server would count a failure', async () => {
    const event = { userId: 1, entries: [] };
    await expect(runHook(plugin, 'entries.added', event)).rejects.toThrow(
      'echo does not implement entries.added',
    );
    await expect(
      runHook(plugin, 'published.changed', {
        userId: 1,
        feedUrl: null,
        published: [],
        unpublished: [],
      }),
    ).rejects.toThrow(z.ZodError);
    const slow = definePlugin({
      ...plugin,
      hooks: { 'entries.added': { run: () => new Promise(() => undefined) } },
    });
    await expect(
      runHook(slow, 'entries.added', event, { settings: { key: 'k' }, timeoutMs: 20 }),
    ).rejects.toThrow('ran out of time');
    const long = definePlugin({
      ...plugin,
      hooks: { 'digest.compose': { run: () => ({ overview: 'x'.repeat(4001) }) } },
    });
    await expect(
      runHook(
        long,
        'digest.compose',
        { userId: 1, language: 'en', frequency: 'daily', entries: [], more: 0 },
        { settings: { key: 'k' } },
      ),
    ).rejects.toThrow('does not take');
    await expect(
      runHook({ ...plugin, apiVersion: '^0.2' }, 'published.changed', {
        userId: 1,
        feedUrl: null,
        published: [],
        unpublished: [],
      }),
    ).rejects.toThrow('does not accept the plugin API');
  });
});
