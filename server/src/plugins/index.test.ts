import { type DigestComposeInput, EVENT_LIMITS, type PluginContext } from '@newses/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MAX_DELIVERY_EVENTS } from '../core/plugins/events.ts';
import type { PluginRuntime } from '../core/plugins/settings.ts';
import type { KeyValueStore } from '../core/plugins/storage.ts';
import { silentLogger } from '../test/fakes.ts';
import {
  DigestHookComposer,
  EventHookRunner,
  EVENT_HOOK_TIMEOUT_MS,
  HookTester,
  pluginName,
} from './index.ts';
import { PluginNetwork } from './network.ts';
import { PluginRegistry } from './registry.ts';
import { type HookOutcome, type HookRun, PluginRunner } from './runner.ts';

const run = vi.fn();
const registry = PluginRegistry.load(
  [
    {
      source: 'w@1.0.0',
      plugin: {
        id: 'webhook',
        version: '1.0.0',
        apiVersion: '^0.1',
        scopes: ['user'],
        hooks: { 'published.changed': { debounceSeconds: 120, run } },
      },
    },
  ],
  { logger: silentLogger },
);
const plugin = registry.get('webhook');

describe('EventHookRunner', () => {
  it("runs the plugin's hook for the user under the event time limit", async () => {
    const runs: HookRun<unknown>[] = [];
    let outcome: HookOutcome<unknown> = { ok: true, value: undefined };
    const runner = new EventHookRunner(registry, {
      run: (r: HookRun<unknown>) => {
        runs.push(r);
        return Promise.resolve(outcome);
      },
    } as unknown as PluginRunner);
    if (!plugin) throw new Error('not loaded');
    const event = { userId: 3, feedUrl: null, published: [], unpublished: [1] };
    expect(await runner.run(plugin, 'published.changed', 3, event)).toBe('ok');
    expect(runs[0]).toMatchObject({
      hook: 'published.changed',
      userId: 3,
      timeoutMs: EVENT_HOOK_TIMEOUT_MS,
    });
    const context = { pluginId: 'webhook' };
    await runs[0]?.call(context as never);
    expect(run).toHaveBeenCalledWith(event, context);

    outcome = { ok: false, failure: 'timeout' };
    expect(await runner.run(plugin, 'published.changed', 3, event)).toBe('failed');
    outcome = { ok: false, failure: 'disabled' };
    expect(await runner.run(plugin, 'published.changed', 3, event)).toBe('disabled');
    expect(await runner.run(plugin, 'entries.added', 3, event)).toBe('disabled');
    expect(plugin.events).toEqual(new Map([['published.changed', { debounceSeconds: 120 }]]));
  });

  it("keeps to the contract's limits", () => {
    expect(EVENT_HOOK_TIMEOUT_MS).toBe(EVENT_LIMITS.timeoutSeconds * 1000);
    expect(MAX_DELIVERY_EVENTS).toBe(EVENT_LIMITS.entries);
  });
});

/** Hook runs as the server makes them, with the plugins in `off` off. */
function realRunner(off: string[] = []) {
  return new PluginRunner({
    network: new PluginNetwork({
      polite: { request: (_host, send) => send() },
      ops: null,
      userAgent: 'Newses/test',
    }),
    logger: silentLogger,
    ops: null,
    settings: {
      runtime: (plugin): Promise<PluginRuntime> =>
        Promise.resolve(
          off.includes(plugin.id)
            ? { active: false, reason: 'disabled' }
            : { active: true, approvedHosts: new Set(), settings: {}, userSettings: null },
        ),
      recordRun: () => Promise.resolve(null),
    },
    storage: { store: () => ({}) as KeyValueStore },
  });
}

describe('HookTester', () => {
  const testing = (id: string, run: () => unknown) => ({
    source: `${id}@1.0.0`,
    plugin: {
      id,
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['instance'],
      hooks: { test: { run } },
    },
  });
  const plugins = PluginRegistry.load(
    [
      testing('passes', () => ({ ok: true, message: ' HTTP 204\r\nNo Content ' })),
      testing('reports', () => Promise.resolve({ ok: false, message: 'HTTP 401' })),
      testing('throws', () => {
        throw new Error('connect ECONNREFUSED');
      }),
      testing('slow', () => new Promise(() => undefined)),
      testing('odd', () => ({ ok: 'yes' })),
      testing('off', () => ({ ok: true, message: '' })),
      { source: 'plain@1.0.0', plugin: { ...testing('plain', () => null).plugin, hooks: {} } },
    ],
    { logger: silentLogger },
  );
  const tester = new HookTester(plugins, realRunner(['off']), 30);
  const outcomeOf = (id: string) => {
    const plugin = plugins.get(id);
    if (!plugin) throw new Error(`no ${id}`);
    return tester.test(plugin, 3);
  };

  it("reports the plugin's result, or how its test failed", async () => {
    expect(plugins.get('passes')?.testable).toBe(true);
    expect(plugins.get('plain')?.testable).toBe(false);
    expect(await outcomeOf('passes')).toEqual({
      ok: true,
      message: 'HTTP 204\nNo Content',
      failure: null,
    });
    expect(await outcomeOf('reports')).toEqual({ ok: false, message: 'HTTP 401', failure: null });
    expect(await outcomeOf('throws')).toEqual({
      ok: false,
      message: 'connect ECONNREFUSED',
      failure: 'error',
    });
    expect(await outcomeOf('slow')).toEqual({ ok: false, message: '', failure: 'timeout' });
    expect(await outcomeOf('odd')).toEqual({ ok: false, message: '', failure: 'invalid' });
    expect(await outcomeOf('off')).toBe('off');
    expect(await outcomeOf('plain')).toBe('off');
  });

  it('runs an action as a test, uncounted, with the digest only when it takes one', async () => {
    const given: unknown[] = [];
    const acting = PluginRegistry.load(
      [
        {
          source: 'acting@1.0.0',
          plugin: {
            id: 'acting',
            version: '1.0.0',
            apiVersion: '^0.1',
            scopes: ['user'],
            settings: { user: z.object({}) },
            hooks: {},
            actions: {
              priced: {
                digest: true,
                run: (_context: unknown, digest: unknown) => {
                  given.push(digest);
                  return { ok: true, message: ' About $0.95\r\n ' };
                },
              },
              plain: {
                run: (_context: unknown, digest: unknown) => {
                  given.push(digest);
                  return { ok: false, message: 'No key' };
                },
              },
              throws: {
                run: () => {
                  throw new Error('no key');
                },
              },
            },
          },
        },
      ],
      { logger: silentLogger },
    );
    const info = acting.get('acting');
    if (!info) throw new Error('not loaded');
    expect(info.actions).toEqual([
      { name: 'priced', digest: true },
      { name: 'plain', digest: false },
      { name: 'throws', digest: false },
    ]);
    const counted: (boolean | undefined)[] = [];
    const real = realRunner();
    const actor = new HookTester(acting, {
      run: (hookRun) => {
        counted.push(hookRun.counted);
        return real.run(hookRun);
      },
    });
    const digest = {
      userId: 3,
      language: 'en',
      frequency: 'daily' as const,
      entries: [],
      more: 0,
      unlisted: [],
    };
    expect(await actor.act(info, 'priced', 3, digest)).toEqual({
      ok: true,
      message: 'About $0.95',
      failure: null,
    });
    expect(await actor.act(info, 'plain', 3, digest)).toEqual({
      ok: false,
      message: 'No key',
      failure: null,
    });
    expect(given).toEqual([digest, null]);
    expect(await actor.act(info, 'throws', 3, null)).toEqual({
      ok: false,
      message: 'no key',
      failure: 'error',
    });
    expect(await actor.act(info, 'missing', 3, null)).toBe('off');
    expect(counted).toEqual([false, false, false]);
  });
});

describe('DigestHookComposer', () => {
  const input: DigestComposeInput = {
    userId: 3,
    language: 'pt-BR',
    frequency: 'daily',
    entries: [10, 11].map((id) => ({
      id,
      title: `Post ${String(id)}`,
      link: null,
      author: null,
      publishedAt: '2026-06-15T04:00:00.000Z',
      published: false,
      unread: true,
      feed: null,
      excerpt: 'About it',
      contentHash: `h${String(id)}`,
    })),
    more: 0,
    unlisted: [],
  };
  const composing = (id: string, run: (i: DigestComposeInput, c: PluginContext) => unknown) => ({
    source: `${id}@1.0.0`,
    plugin: {
      id,
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['instance'],
      messages: { en: { name: `${id} (en)` }, pt: { name: `${id} (pt)` } },
      hooks: { 'digest.compose': { run } },
    },
  });

  /** A composer over real hook runs, with the plugins in `off` off for the user. */
  function composer(installed: ReturnType<typeof composing>[], off: string[] = []) {
    const plugins = PluginRegistry.load(installed, { logger: silentLogger });
    return new DigestHookComposer(plugins, realRunner(off), 50);
  }

  it('composes nothing without plugins that compose digests', async () => {
    const none = composer([]);
    expect(none.composes).toBe(false);
    expect(await none.compose(input)).toEqual([]);
  });

  it('gives each plugin the digest and keeps its text for listed entries, cleaned', async () => {
    const seen: DigestComposeInput[] = [];
    const additions = await composer([
      composing('summary', (given) => {
        seen.push(given);
        given.entries.length = 0;
        return {
          overview: '  Two posts.\r\n\r\n\r\n\r\nBoth <b>new</b>.\u0007  ',
          entries: [
            { id: 10, text: 'First' },
            { id: 10, text: 'Again' },
            { id: 99, text: 'Not listed' },
            { id: 11, text: '   ' },
          ],
        };
      }),
      composing('tags', (given) => {
        seen.push(given);
        return Promise.resolve({ entries: [{ id: 11, text: 'tagged' }] });
      }),
      composing('quiet', () => undefined),
    ]).compose(input);
    expect(seen.map((given) => given.entries.length)).toEqual([0, 2]);
    expect(additions).toEqual([
      {
        pluginId: 'summary',
        name: 'summary (pt)',
        overview: 'Two posts.\n\nBoth <b>new</b>.',
        entries: new Map([[10, 'First']]),
      },
      { pluginId: 'tags', name: 'tags (pt)', overview: null, entries: new Map([[11, 'tagged']]) },
    ]);
  });

  it('leaves out plugins that fail, time out, return too much, or are off for the user', async () => {
    const additions = await composer(
      [
        composing('throws', () => {
          throw new Error('no key');
        }),
        composing('slow', () => new Promise(() => undefined)),
        composing('long', () => ({ overview: 'x'.repeat(4001) })),
        composing('off', () => ({ overview: 'Off' })),
        composing('fine', () => ({ overview: 'Fine' })),
      ],
      ['off'],
    ).compose(input);
    expect(additions.map((addition) => addition.pluginId)).toEqual(['fine']);
  });

  it('tests the plugins on for the user, uncounted, saying why any added nothing', async () => {
    const plugins = PluginRegistry.load(
      [
        composing('fine', () => ({ overview: ' Fine ' })),
        composing('quiet', () => null),
        composing('throws', () => {
          throw new Error('HTTP 401 from the API');
        }),
        composing('slow', () => new Promise(() => undefined)),
        composing('off', () => ({ overview: 'Off' })),
      ],
      { logger: silentLogger },
    );
    const real = realRunner(['off']);
    const counted: (boolean | undefined)[] = [];
    const tests = new DigestHookComposer(
      plugins,
      {
        run: (hookRun) => {
          counted.push(hookRun.counted);
          return real.run(hookRun);
        },
      },
      50,
    );
    const [fine, ...failed] = await tests.composeTest(input);
    expect(fine).toEqual({
      name: 'fine (pt)',
      addition: { pluginId: 'fine', name: 'fine (pt)', overview: 'Fine', entries: new Map() },
      failure: null,
      detail: null,
    });
    expect(failed.map(({ name, failure, detail }) => [name, failure, detail])).toEqual([
      ['quiet (pt)', 'empty', null],
      ['throws (pt)', 'error', 'HTTP 401 from the API'],
      ['slow (pt)', 'timeout', null],
    ]);
    expect(counted).toEqual([false, false, false, false, false]);
  });

  it("names a plugin in the digest's language, its language, English, else by id", () => {
    const messages = { en: { name: 'Summary' }, de: { name: 'Zusammenfassung' } };
    expect(pluginName({ id: 's', messages }, 'de-AT')).toBe('Zusammenfassung');
    expect(pluginName({ id: 's', messages }, 'fr')).toBe('Summary');
    expect(pluginName({ id: 's', messages: {} }, 'fr')).toBe('s');
  });
});
