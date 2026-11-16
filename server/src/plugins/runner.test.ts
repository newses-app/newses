import type { PluginContext } from '@newses/plugin-api';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type { Logger } from '../core/ports.ts';
import { PluginNetwork } from './network.ts';
import type { LoadedPlugin } from './registry.ts';
import { hookJobName, pluginLogger, PluginRunner } from './runner.ts';

const plugin: LoadedPlugin = {
  source: '@newses/plugin-webhook@1.0.0',
  definition: {
    id: 'webhook',
    version: '1.0.0',
    apiVersion: '^0.1',
    scopes: ['user'],
    hosts: ['hooks.example'],
    hooks: {},
  },
};

let logger: {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
let ops: { recordJob: Mock<OpsRecorder['recordJob']> };
let runner: PluginRunner;

beforeEach(() => {
  logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  ops = { recordJob: vi.fn<OpsRecorder['recordJob']>() };
  const network = new PluginNetwork({
    polite: { request: (_host, send) => send() },
    ops: null,
    userAgent: 'Newses/test',
  });
  runner = new PluginRunner({
    network,
    logger: logger as Logger,
    ops,
    approvedHosts: (id) => new Set(id === 'webhook' ? ['hooks.example'] : []),
  });
});

const recorded = () => ops.recordJob.mock.calls.map(([run]) => run);

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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'webhook', hook: 'h', failure: 'error' }),
      'Plugin hook failed',
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
    await expect(context?.fetch('https://elsewhere.example/')).rejects.toThrow(
      'elsewhere.example is not approved for the plugin webhook',
    );
    context?.logger.info('Sent', { status: 204 });
    expect(logger.info).toHaveBeenCalledWith({ status: 204, plugin: 'webhook' }, 'Sent');
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
