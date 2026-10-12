import { SpanKind } from '@opentelemetry/api';
import {
  FetchError,
  type Fetcher,
  type FetchRequest,
  type FetchResult,
} from '../core/feeds/http.ts';
import type { FetchOutcome, OpsRecorder } from '../core/ops/recorder.ts';
import { getInstruments, withSpan } from '../telemetry/index.ts';

/** Host and port only: paths and queries of feed URLs may carry private tokens. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

export function outcomeOf(err: unknown): FetchOutcome {
  if (!(err instanceof FetchError)) return 'other';
  switch (err.code) {
    case 'http_status': {
      const status = err.status ?? 0;
      if (status === 429 || (status === 503 && err.retryAfterSeconds !== null))
        return 'rate_limited';
      return status >= 500 ? 'server_error' : 'client_error';
    }
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'blocked_address':
      return 'blocked';
    default:
      return 'other';
  }
}

/**
 * Records every request to a remote host: a client span, the outbound metrics, and the per-host
 * hourly statistics. No trace context is sent to the host.
 */
export class InstrumentedFetcher implements Fetcher {
  readonly #inner: Fetcher & { close(): Promise<void> };
  readonly #ops: OpsRecorder | null;

  constructor(inner: Fetcher & { close(): Promise<void> }, ops: OpsRecorder | null) {
    this.#inner = inner;
    this.#ops = ops;
  }

  fetch(url: string, request: FetchRequest = {}): Promise<FetchResult> {
    const host = hostOf(url);
    const purpose = request.purpose ?? 'feed';
    return withSpan(
      `GET ${host}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': 'GET',
          'server.address': host,
          'rss.fetch.purpose': purpose,
        },
      },
      async (span) => {
        const started = performance.now();
        let outcome: FetchOutcome = 'other';
        let bytes = 0;
        try {
          const result = await this.#inner.fetch(url, request);
          outcome = result.notModified ? 'not_modified' : 'ok';
          bytes = result.body.byteLength;
          span.setAttributes({
            'http.response.status_code': result.status,
            'http.response.body.size': bytes,
          });
          return result;
        } catch (err) {
          outcome = outcomeOf(err);
          if (err instanceof FetchError) {
            span.setAttribute('error.type', err.code);
            if (err.status !== null) span.setAttribute('http.response.status_code', err.status);
            if (err.retryAfterSeconds !== null)
              span.setAttribute('rss.fetch.retry_after_seconds', err.retryAfterSeconds);
          }
          throw err;
        } finally {
          const durationMs = performance.now() - started;
          span.setAttribute('rss.fetch.outcome', outcome);
          const instruments = getInstruments();
          const attributes = { 'rss.fetch.purpose': purpose, 'rss.fetch.outcome': outcome };
          instruments.outboundRequests.add(1, attributes);
          instruments.outboundDuration.record(durationMs / 1000, attributes);
          this.#ops?.recordFetch({ host, purpose, outcome, bytes, durationMs });
        }
      },
    );
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
