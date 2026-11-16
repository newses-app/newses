import type { PluginContext } from '@newses/plugin-api';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type { PluginRuntime, PluginSettingsService } from '../core/plugins/settings.ts';
import type { KeyValueStore } from '../core/plugins/storage.ts';
import type { Logger } from '../core/ports.ts';
import { PluginNetwork } from './network.ts';
import { type LoadedPlugin, PluginRegistry } from './registry.ts';
import { hookJobName, pluginLogger, PluginRunner } from './runner.ts';

const plugin = PluginRegistry.load(
  [
    {
      source: '@newses/plugin-webhook@1.0.0',
      plugin: {
        id: 'webhook',
        version: '1.0.0',
        apiVersion: '^0.1',
        scopes: ['user'],
        hosts: ['hooks.example'],
        settings: { user: z.object({ target: z.string() }) },
        hooks: {},
      },
    },
  ],
  { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
).get('webhook') as LoadedPlugin;

const store = (name: string) => ({ name }) as unknown as KeyValueStore;

let logger: {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
let ops: { recordJob: Mock<OpsRecorder['recordJob']> };
let runtime: PluginRuntime | Error;
let settings: {
  runtime: Mock<PluginSettingsService['runtime']>;
  recordRun: Mock<PluginSettingsService['recordRun']>;
};
let runner: PluginRunner;

beforeEach(() => {
  logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  ops = { recordJob: vi.fn<OpsRecorder['recordJob']>() };
  const network = new PluginNetwork({
    polite: { request: (_host, send) => send() },
    ops: null,
    userAgent: 'Newses/test',
  });
  runtime = {
    active: true,
    approvedHosts: new Set(['hooks.example']),
    settings: { region: 'eu' },
    userSettings: null,
  };
  settings = {
    runtime: vi.fn<PluginSettingsService['runtime']>(() =>
      runtime instanceof Error ? Promise.reject(runtime) : Promise.resolve(runtime),
    ),
    recordRun: vi.fn<PluginSettingsService['recordRun']>(() => Promise.resolve(null)),
  };
  runner = new PluginRunner({
    network,
    logger: logger as Logger,
    ops,
    settings,
    storage: { store: (id, userId) => store(`${id}:${String(userId)}`) },
  });
});

const recorded = () => ops.recordJob.mock.calls.map(([run]) => run);
const counted = () => settings.recordRun.mock.calls.map(([, userId, outcome]) => [userId, outcome]);

describe('PluginRunner', () => {
  it('returns what a hook gives, checked against the hook output', async () => {
    const outcome = await runner.run({
      plugin,
      hook: 'digest.compose',
      timeoutMs: 1000,
      output: z.object({ overview: z.string() }),
      call: () => Promise.resolve({ overview: 'Three new posts', extra: true }),
    });
    expect(outcome).toEqual({ ok: true, value: { overview: 'Three new posts' } });
    expect(recorded()).toEqual([
      expect.objectContaining({ job: 'plugin:webhook:digest.compose', ok: true }),
    ]);
    expect(counted()).toEqual([[null, { ok: true }]]);
  });

  it('ignores the result of hooks without an output', async () => {
    const outcome = await runner.run({
      plugin,
      hook: 'h',
      timeoutMs: 1000,
      call: () => 'anything',
    });
    expect(outcome).toEqual({ ok: true, value: undefined });
  });

  it('counts a hook that throws, sync or async, as failed and logs it', async () => {
    for (const call of [
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('boom')),
    ]) {
      expect(await runner.run({ plugin, hook: 'h', timeoutMs: 1000, call })).toEqual({
        ok: false,
        failure: 'error',
      });
    }
    expect(recorded().map((r) => r.ok)).toEqual([false, false]);
    expect(counted()).toEqual([
      [null, { ok: false, failure: 'error' }],
      [null, { ok: false, failure: 'error' }],
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'webhook', hook: 'h', failure: 'error' }),
      'Plugin hook failed',
    );
  });

  it('runs nothing for a plugin that is off, or whose settings no longer fit', async () => {
    const call = vi.fn();
    for (const reason of ['disabled', 'invalid_settings'] as const) {
      runtime = { active: false, reason };
      expect(await runner.run({ plugin, hook: 'h', userId: 3, timeoutMs: 1000, call })).toEqual({
        ok: false,
        failure: 'disabled',
      });
    }
    expect(call).not.toHaveBeenCalled();
    expect(settings.runtime).toHaveBeenCalledWith(plugin, 3);
    expect(recorded()).toEqual([]);
    expect(counted()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('counts unreadable settings as a failed run', async () => {
    runtime = new Error('Sealed value cannot be opened');
    const call = vi.fn();
    expect(await runner.run({ plugin, hook: 'h', userId: 3, timeoutMs: 1000, call })).toEqual({
      ok: false,
      failure: 'error',
    });
    expect(call).not.toHaveBeenCalled();
    expect(recorded()).toEqual([expect.objectContaining({ ok: false })]);
    expect(counted()).toEqual([[3, { ok: false, failure: 'error' }]]);
  });

  it('says when failing turned the plugin off, and survives failing to count', async () => {
    settings.recordRun.mockResolvedValueOnce('user');
    const call = () => Promise.reject(new Error('boom'));
    await runner.run({ plugin, hook: 'h', userId: 3, timeoutMs: 1000, call });
    expect(logger.warn).toHaveBeenCalledWith(
      { plugin: 'webhook', hook: 'h', scope: 'user', userId: 3 },
      'Plugin turned off after failing repeatedly',
    );
    settings.recordRun.mockRejectedValueOnce(new Error('database down'));
    expect(await runner.run({ plugin, hook: 'h', timeoutMs: 1000, call })).toEqual({
      ok: false,
      failure: 'error',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'webhook' }),
      'Plugin run not counted',
    );
  });

  it('gives up on a hook past its time, aborting its signal', async () => {
    let signal: AbortSignal | undefined;
    const outcome = await runner.run({
      plugin,
      hook: 'h',
      timeoutMs: 20,
      call: (context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      },
    });
    expect(outcome).toEqual({ ok: false, failure: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failure: 'timeout' }),
      'Plugin hook ran out of time',
    );
  });

  it('counts a result the hook does not take as invalid', async () => {
    const outcome = await runner.run({
      plugin,
      hook: 'h',
      timeoutMs: 1000,
      output: z.object({ overview: z.string() }),
      call: () => ({ overview: 42 }),
    });
    expect(outcome).toEqual({ ok: false, failure: 'invalid' });
    expect(recorded()).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("gives hooks a context limited to the plugin's approved hosts", async () => {
    let context: PluginContext | undefined;
    await runner.run({
      plugin,
      hook: 'h',
      timeoutMs: 1000,
      call: (c) => {
        context = c;
      },
    });
    expect(context?.pluginId).toBe('webhook');
    expect(context?.settings).toEqual({ region: 'eu' });
    expect(context?.userSettings).toBeNull();
    expect(context?.storage).toEqual({ name: 'webhook:null' });
    expect(context?.userStorage).toBeNull();
    await expect(context?.fetch('https://elsewhere.example/')).rejects.toThrow(
      'elsewhere.example is not approved for the plugin webhook',
    );
    context?.logger.info('Sent', { status: 204 });
    expect(logger.info).toHaveBeenCalledWith({ status: 204, plugin: 'webhook' }, 'Sent');
  });

  it("gives a user's run their settings and storage", async () => {
    runtime = {
      active: true,
      approvedHosts: new Set(),
      settings: {},
      userSettings: { target: 'https://hooks.example/' },
    };
    let context: PluginContext | undefined;
    await runner.run({
      plugin,
      hook: 'h',
      userId: 7,
      timeoutMs: 1000,
      call: (c) => {
        context = c;
      },
    });
    expect(context?.userSettings).toEqual({ target: 'https://hooks.example/' });
    expect(context?.storage).toEqual({ name: 'webhook:null' });
    expect(context?.userStorage).toEqual({ name: 'webhook:7' });
    expect(counted()).toEqual([[7, { ok: true }]]);
  });
});

describe('pluginLogger', () => {
  it("tags lines with the plugin's id, which plugins cannot override", () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scoped = pluginLogger(log, 'webhook');
    scoped.error('Failed', { plugin: 'other', code: 7 });
    scoped.debug('Plain');
    expect(log.error).toHaveBeenCalledWith({ plugin: 'webhook', code: 7 }, 'Failed');
    expect(log.debug).toHaveBeenCalledWith({ plugin: 'webhook' }, 'Plain');
  });
});

describe('hookJobName', () => {
  it('names a hook as a job', () => {
    expect(hookJobName('webhook', 'published.changed')).toBe('plugin:webhook:published.changed');
  });
});
