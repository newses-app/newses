import { type DigestComposeInput, EVENT_LIMITS, type PluginContext } from '@newses/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { MAX_DELIVERY_EVENTS } from '../core/plugins/events.ts';
import type { PluginRuntime } from '../core/plugins/settings.ts';
import type { KeyValueStore } from '../core/plugins/storage.ts';
import { silentLogger } from '../test/fakes.ts';
import { DigestHookComposer, EventHookRunner, EVENT_HOOK_TIMEOUT_MS, pluginName } from './index.ts';
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
    const runner = new PluginRunner({
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
    return new DigestHookComposer(plugins, runner, 50);
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

  it("names a plugin in the digest's language, its language, English, else by id", () => {
    const messages = { en: { name: 'Summary' }, de: { name: 'Zusammenfassung' } };
    expect(pluginName({ id: 's', messages }, 'de-AT')).toBe('Zusammenfassung');
    expect(pluginName({ id: 's', messages }, 'fr')).toBe('Summary');
    expect(pluginName({ id: 's', messages: {} }, 'fr')).toBe('s');
  });
});
