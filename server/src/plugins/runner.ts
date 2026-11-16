import type { PluginContext, PluginLogger } from '@newses/plugin-api';
import type { z } from 'zod';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type { PluginRuntime, PluginSettingsService } from '../core/plugins/settings.ts';
import type { PluginStorageService } from '../core/plugins/storage.ts';
import type { Logger } from '../core/ports.ts';
import { getInstruments, recordError, withSpan } from '../telemetry/index.ts';
import type { PluginNetwork } from './network.ts';
import type { LoadedPlugin } from './registry.ts';

/**
 * Why a hook gave nothing: it threw, ran out of time, or returned what the hook does not take;
 * or it did not run, the plugin being off (for the instance or the user) or its saved settings
 * no longer what it takes.
 */
export type HookFailure = 'error' | 'timeout' | 'invalid' | 'disabled';

export type HookOutcome<T> = { ok: true; value: T } | { ok: false; failure: HookFailure };

export interface HookRun<T> {
  plugin: LoadedPlugin;
  hook: string;
  /** The user the hook runs for; without one it runs for the instance. */
  userId?: number | null;
  timeoutMs: number;
  /** What the hook must return; without it the hook's result is ignored. */
  output?: z.ZodType<T>;
  call: (context: PluginContext) => unknown;
}

/** The name a plugin's hook is counted under with the jobs: `plugin:<id>:<hook>`. */
export const hookJobName = (pluginId: string, hook: string) => `plugin:${pluginId}:${hook}`;

/**
 * Runs plugins' hooks, when the plugin is on: each under its time limit, with a context of its
 * own, in a span. A hook that throws, times out, or returns something unusable is a failure the
 * caller can skip; it never throws. Each run counts with the jobs, so the Operations page lists
 * plugins' runs and failures and failing ones raise the jobs alert, and toward the failures in a
 * row that turn a plugin off.
 */
export class PluginRunner {
  readonly #network: PluginNetwork;
  readonly #logger: Logger;
  readonly #ops: Pick<OpsRecorder, 'recordJob'> | null;
  readonly #settings: Pick<PluginSettingsService, 'runtime' | 'recordRun'>;
  readonly #storage: Pick<PluginStorageService, 'store'>;

  constructor(deps: {
    network: PluginNetwork;
    logger: Logger;
    ops: Pick<OpsRecorder, 'recordJob'> | null;
    settings: Pick<PluginSettingsService, 'runtime' | 'recordRun'>;
    storage: Pick<PluginStorageService, 'store'>;
  }) {
    this.#network = deps.network;
    this.#logger = deps.logger;
    this.#ops = deps.ops;
    this.#settings = deps.settings;
    this.#storage = deps.storage;
  }

  async run<T>(run: HookRun<T>): Promise<HookOutcome<T>> {
    const pluginId = run.plugin.id;
    const userId = run.userId ?? null;
    const job = hookJobName(pluginId, run.hook);
    const started = performance.now();
    let runtime: PluginRuntime;
    try {
      runtime = await this.#settings.runtime(run.plugin, userId);
    } catch (err) {
      this.#logger.error({ plugin: pluginId, hook: run.hook, err }, 'Plugin settings unreadable');
      const outcome = { ok: false, failure: 'error' } as const;
      await this.#count(run, userId, outcome, performance.now() - started);
      return outcome;
    }
    if (!runtime.active) {
      if (runtime.reason === 'invalid_settings')
        this.#logger.warn(
          { plugin: pluginId, hook: run.hook, userId },
          'Plugin skipped: its settings no longer fit it',
        );
      return { ok: false, failure: 'disabled' };
    }
    const { approvedHosts, settings, userSettings } = runtime;
    return withSpan(
      `plugin ${pluginId} ${run.hook}`,
      { attributes: { 'rss.job': job, 'rss.plugin.id': pluginId, 'rss.plugin.hook': run.hook } },
      async (span): Promise<HookOutcome<T>> => {
        const signal = AbortSignal.timeout(run.timeoutMs);
        const context: PluginContext = {
          pluginId,
          signal,
          logger: pluginLogger(this.#logger, pluginId),
          fetch: this.#network.fetchFor(pluginId, (host) => approvedHosts.has(host), signal),
          settings,
          userSettings,
          storage: this.#storage.store(pluginId, null),
          userStorage: userId === null ? null : this.#storage.store(pluginId, userId),
        };
        let outcome: HookOutcome<T>;
        try {
          const value = await untilAborted(
            Promise.resolve().then(() => run.call(context)),
            signal,
          );
          if (!run.output) outcome = { ok: true, value: undefined as T };
          else {
            const parsed = run.output.safeParse(value);
            outcome = parsed.success
              ? { ok: true, value: parsed.data }
              : { ok: false, failure: 'invalid' };
            if (!parsed.success)
              this.#logger.warn(
                { plugin: pluginId, hook: run.hook, issues: parsed.error.issues.length },
                'Plugin hook returned an unusable result',
              );
          }
        } catch (err) {
          const failure = signal.aborted ? 'timeout' : 'error';
          outcome = { ok: false, failure };
          recordError(span, err);
          this.#logger.warn(
            { plugin: pluginId, hook: run.hook, failure, err },
            failure === 'timeout' ? 'Plugin hook ran out of time' : 'Plugin hook failed',
          );
        }
        span.setAttribute('rss.plugin.outcome', outcome.ok ? 'ok' : outcome.failure);
        await this.#count(run, userId, outcome, performance.now() - started);
        return outcome;
      },
    );
  }

  /** Counts a run with the jobs and toward the plugin's failures in a row. */
  async #count(
    run: HookRun<unknown>,
    userId: number | null,
    outcome: HookOutcome<unknown>,
    durationMs: number,
  ): Promise<void> {
    const pluginId = run.plugin.id;
    const job = hookJobName(pluginId, run.hook);
    this.#ops?.recordJob({ job, ok: outcome.ok, durationMs });
    const instruments = getInstruments();
    instruments.jobDuration.record(durationMs / 1000, { 'rss.job': job });
    if (!outcome.ok) instruments.jobFailures.add(1, { 'rss.job': job });
    try {
      const turnedOff = await this.#settings.recordRun(
        run.plugin,
        userId,
        outcome.ok ? { ok: true } : { ok: false, failure: outcome.failure },
      );
      if (turnedOff)
        this.#logger.warn(
          { plugin: pluginId, hook: run.hook, scope: turnedOff, userId },
          'Plugin turned off after failing repeatedly',
        );
    } catch (err) {
      this.#logger.error({ plugin: pluginId, err }, 'Plugin run not counted');
    }
  }
}

/** The server's logger, with each line tagged with the plugin's id. */
export function pluginLogger(logger: Logger, pluginId: string): PluginLogger {
  const line =
    (level: keyof Logger) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      logger[level]({ ...fields, plugin: pluginId }, message);
    };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
}

/** Settles with `work`, or rejects with the signal's reason once it aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
