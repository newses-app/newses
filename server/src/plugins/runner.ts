import type { PluginContext, PluginLogger } from '@newses/plugin-api';
import type { z } from 'zod';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type { Logger } from '../core/ports.ts';
import { getInstruments, recordError, withSpan } from '../telemetry/index.ts';
import type { PluginNetwork } from './network.ts';
import type { LoadedPlugin } from './registry.ts';

/** Why a hook gave nothing: it threw, ran out of time, or returned what the hook does not take. */
export type HookFailure = 'error' | 'timeout' | 'invalid';

export type HookOutcome<T> = { ok: true; value: T } | { ok: false; failure: HookFailure };

export interface HookRun<T> {
  plugin: LoadedPlugin;
  hook: string;
  timeoutMs: number;
  /** What the hook must return; without it the hook's result is ignored. */
  output?: z.ZodType<T>;
  call: (context: PluginContext) => unknown;
}

/** The name a plugin's hook is counted under with the jobs: `plugin:<id>:<hook>`. */
export const hookJobName = (pluginId: string, hook: string) => `plugin:${pluginId}:${hook}`;

/**
 * Runs plugins' hooks: each under its time limit, with a context of its own, in a span. A hook
 * that throws, times out, or returns something unusable is a failure the caller can skip; it
 * never throws. Each run counts with the jobs, so the Operations page lists plugins' runs and
 * failures, and failing ones raise the jobs alert.
 */
export class PluginRunner {
  readonly #network: PluginNetwork;
  readonly #logger: Logger;
  readonly #ops: Pick<OpsRecorder, 'recordJob'> | null;
  readonly #approvedHosts: (pluginId: string) => ReadonlySet<string>;

  constructor(deps: {
    network: PluginNetwork;
    logger: Logger;
    ops: Pick<OpsRecorder, 'recordJob'> | null;
    /** The hosts an admin approved for each plugin. */
    approvedHosts: (pluginId: string) => ReadonlySet<string>;
  }) {
    this.#network = deps.network;
    this.#logger = deps.logger;
    this.#ops = deps.ops;
    this.#approvedHosts = deps.approvedHosts;
  }

  run<T>(run: HookRun<T>): Promise<HookOutcome<T>> {
    const pluginId = run.plugin.definition.id;
    const job = hookJobName(pluginId, run.hook);
    return withSpan(
      `plugin ${pluginId} ${run.hook}`,
      { attributes: { 'rss.job': job, 'rss.plugin.id': pluginId, 'rss.plugin.hook': run.hook } },
      async (span): Promise<HookOutcome<T>> => {
        const started = performance.now();
        const signal = AbortSignal.timeout(run.timeoutMs);
        const hosts = this.#approvedHosts(pluginId);
        const context: PluginContext = {
          pluginId,
          signal,
          logger: pluginLogger(this.#logger, pluginId),
          fetch: this.#network.fetchFor(pluginId, (host) => hosts.has(host), signal),
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
        const durationMs = performance.now() - started;
        span.setAttribute('rss.plugin.outcome', outcome.ok ? 'ok' : outcome.failure);
        this.#ops?.recordJob({ job, ok: outcome.ok, durationMs });
        const instruments = getInstruments();
        instruments.jobDuration.record(durationMs / 1000, { 'rss.job': job });
        if (!outcome.ok) instruments.jobFailures.add(1, { 'rss.job': job });
        return outcome;
      },
    );
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
