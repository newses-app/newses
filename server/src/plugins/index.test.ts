import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../test/fakes.ts';
import { EventHookRunner, EVENT_HOOK_TIMEOUT_MS } from './index.ts';
import { PluginRegistry } from './registry.ts';
import type { HookOutcome, HookRun, PluginRunner } from './runner.ts';

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
});
