import { type Context, SpanKind } from '@opentelemetry/api';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import { getInstruments, withSpan } from '../telemetry/index.ts';

/**
 * Runs a job or scheduled task in a span, counting its duration and outcome in the ops statistics
 * and metrics. `parent` continues the trace of whatever enqueued the job.
 */
export function trackRun<T>(
  ops: OpsRecorder,
  name: string,
  run: () => Promise<T>,
  options: { kind?: 'job' | 'task'; parent?: Context } = {},
): Promise<T> {
  const kind = options.kind ?? 'job';
  return withSpan(
    `${kind} ${name}`,
    {
      // With a parent the span consumes a message; under pg-boss's own consumer span it is internal.
      kind: options.parent ? SpanKind.CONSUMER : SpanKind.INTERNAL,
      attributes: { 'rss.job': name },
      ...(options.parent && { parent: options.parent }),
    },
    async () => {
      const started = performance.now();
      let ok = false;
      try {
        const result = await run();
        ok = true;
        return result;
      } finally {
        const durationMs = performance.now() - started;
        ops.recordJob({ job: name, ok, durationMs });
        const instruments = getInstruments();
        instruments.jobDuration.record(durationMs / 1000, { 'rss.job': name });
        if (!ok) instruments.jobFailures.add(1, { 'rss.job': name });
      }
    },
  );
}

/** Flushes the ops statistics every minute, and once more on shutdown. */
export function scheduleOpsFlush(
  ops: OpsRecorder,
  onShutdown: (step: () => Promise<void>) => void,
): void {
  const timer = setInterval(() => void ops.flush(), 60_000);
  timer.unref();
  onShutdown(async () => {
    clearInterval(timer);
    await ops.flush();
  });
}
