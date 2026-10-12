// OpenTelemetry API helpers. Without a registered SDK every call here is a cheap no-op.
import {
  type Attributes,
  type Context,
  context,
  type Counter,
  type Histogram,
  isSpanContextValid,
  metrics,
  type ObservableGauge,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

const SCOPE = 'rss-reader';

/** Export is on when an OTLP endpoint is configured and the SDK is not disabled. */
export function telemetryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) &&
    env.OTEL_SDK_DISABLED !== 'true',
  );
}

export const tracer = () => trace.getTracer(SCOPE);

/** Runs `fn` in a new active span, recording a thrown error on it. */
export function withSpan<T>(
  name: string,
  options: SpanOptions & { parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const { parent, ...spanOptions } = options;
  return tracer().startActiveSpan(
    name,
    spanOptions,
    parent ?? context.active(),
    async (span): Promise<T> => {
      try {
        return await fn(span);
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export function recordError(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.name : 'Error',
  });
}

/** `trace_id` and `span_id` of the active span, for log lines; empty outside a sampled span. */
export function logTraceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

/** The active trace context as W3C headers, for job payloads; empty when there is none. */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** The context a producer injected, or the root context. */
export function extractTraceContext(carrier: Record<string, string> | undefined): Context {
  return carrier ? propagation.extract(ROOT_CONTEXT, carrier) : ROOT_CONTEXT;
}

/** Low-cardinality instruments; per-host and per-user detail lives in the ops tables instead. */
export interface Instruments {
  httpDuration: Histogram;
  outboundRequests: Counter;
  outboundDuration: Histogram;
  jobDuration: Histogram;
  jobFailures: Counter;
  alertsActive: ObservableGauge;
}

let instruments: Instruments | undefined;

// Bucket boundaries in seconds; the SDK's defaults suit milliseconds.
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const FETCH_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20];
const JOB_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900];

/** Created on first use, after the preload has registered the SDK's meter provider. */
export function getInstruments(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter(SCOPE);
  instruments = {
    httpDuration: meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests.',
      unit: 's',
      advice: { explicitBucketBoundaries: REQUEST_BUCKETS },
    }),
    outboundRequests: meter.createCounter('rss.outbound.requests', {
      description: 'Requests to remote hosts by purpose and outcome.',
      unit: '{request}',
    }),
    outboundDuration: meter.createHistogram('rss.outbound.duration', {
      description: 'Duration of requests to remote hosts.',
      unit: 's',
      advice: { explicitBucketBoundaries: FETCH_BUCKETS },
    }),
    jobDuration: meter.createHistogram('rss.jobs.duration', {
      description: 'Duration of background jobs and scheduled tasks.',
      unit: 's',
      advice: { explicitBucketBoundaries: JOB_BUCKETS },
    }),
    jobFailures: meter.createCounter('rss.jobs.failures', {
      description: 'Background jobs and scheduled tasks that failed.',
      unit: '{job}',
    }),
    alertsActive: meter.createObservableGauge('rss.ops.alerts.active', {
      description: 'Open operations alerts.',
      unit: '{alert}',
    }),
  };
  return instruments;
}

let openAlerts = 0;
let observingAlerts = false;

/** Reports the open-alert count on `rss.ops.alerts.active` from now on. */
export function setOpenAlerts(count: number): void {
  openAlerts = count;
  if (observingAlerts) return;
  observingAlerts = true;
  getInstruments().alertsActive.addCallback((result) => {
    result.observe(openAlerts);
  });
}

export type { Attributes };

let shutdownHook: (() => Promise<void>) | null = null;

/** Set by the SDK bootstrap; flushes and stops exporters. */
export function onTelemetryShutdown(hook: () => Promise<void>): void {
  shutdownHook = hook;
}

/** Flushes pending telemetry; a no-op when export is off. */
export async function shutdownTelemetry(): Promise<void> {
  await shutdownHook?.();
}
