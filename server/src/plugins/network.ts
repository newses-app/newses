import { isIP } from 'node:net';
import { SpanKind } from '@opentelemetry/api';
import { Agent, fetch, Headers, type RequestInit, type Response } from 'undici';
import { addressFilter, FetchError, guardedLookup, parseRetryAfter } from '../core/feeds/http.ts';
import { DEFAULT_HOST_COOLDOWN_SECONDS, type PoliteFetcher } from '../core/feeds/polite-fetcher.ts';
import type { FetchOutcome, OpsRecorder } from '../core/ops/recorder.ts';
import { getInstruments, withSpan } from '../telemetry/index.ts';

export interface PluginNetworkOptions {
  polite: Pick<PoliteFetcher, 'request'>;
  ops: Pick<OpsRecorder, 'recordFetch'> | null;
  /** Private addresses plugins may reach, as for feeds; blocked by default. */
  allowPrivateNetworks?: boolean | string[];
  userAgent: string;
  /** Upper bound for one request; the hook's own time limit usually ends it sooner. */
  timeoutMs?: number;
}

/** What a plugin's request is asked for, after the request's URL is read. */
interface Outgoing {
  url: URL;
  init: RequestInit;
}

/**
 * Plugins' requests to remote hosts: through the polite fetcher's per-host limits and pauses,
 * only to hosts approved for the plugin, never to private addresses unless the operator allows
 * them, without following redirects. Each request gets a client span, the outbound metrics, and
 * the per-host statistics (purpose `plugin`). No trace context is sent.
 */
export class PluginNetwork {
  readonly #polite: Pick<PoliteFetcher, 'request'>;
  readonly #ops: Pick<OpsRecorder, 'recordFetch'> | null;
  readonly #isAllowed: (address: string) => boolean;
  readonly #agent: Agent;
  readonly #userAgent: string;
  readonly #timeoutMs: number;

  constructor(options: PluginNetworkOptions) {
    this.#polite = options.polite;
    this.#ops = options.ops;
    this.#isAllowed = addressFilter(options.allowPrivateNetworks);
    this.#agent = new Agent({ connect: { lookup: guardedLookup(this.#isAllowed) } });
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * A standard `fetch` for one plugin's hook: `isApproved` decides each host, and `signal` (the
   * hook's) ends every request still running.
   */
  fetchFor(
    pluginId: string,
    isApproved: (host: string) => boolean,
    signal: AbortSignal,
  ): typeof globalThis.fetch {
    const pluginFetch = async (
      input: string | URL | globalThis.Request,
      init?: globalThis.RequestInit,
    ): Promise<Response> => {
      const { url, init: request } = await outgoing(input, init);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new TypeError(`Plugins fetch http(s) URLs only, not ${url.protocol}`);
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!isApproved(host))
        throw new TypeError(`${host} is not approved for the plugin ${pluginId}`);
      // IP literals skip DNS lookup, so check them here.
      if (isIP(host) && !this.#isAllowed(host)) throw new TypeError(`${host} is a private address`);
      return this.#send(pluginId, host, url, request, signal);
    };
    return pluginFetch;
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  #send(
    pluginId: string,
    host: string,
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    return withSpan(
      `${method} ${host}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': method,
          'server.address': host,
          'rss.fetch.purpose': 'plugin',
          'rss.plugin.id': pluginId,
        },
      },
      async (span) => {
        const started = performance.now();
        let outcome: FetchOutcome = 'other';
        let bytes = 0;
        try {
          const headers = new Headers(init.headers);
          if (!headers.has('user-agent')) headers.set('user-agent', this.#userAgent);
          const signals = [signal, AbortSignal.timeout(this.#timeoutMs)];
          if (init.signal) signals.push(init.signal);
          const response = await this.#polite.request(
            host,
            () =>
              fetch(url, {
                ...init,
                headers,
                redirect: 'manual',
                signal: AbortSignal.any(signals),
                dispatcher: this.#agent,
              }),
            pauseSeconds,
          );
          outcome = statusOutcome(response.status);
          bytes = Number(response.headers.get('content-length')) || 0;
          span.setAttribute('http.response.status_code', response.status);
          return response;
        } catch (err) {
          outcome = errorOutcome(err);
          span.setAttribute('error.type', outcome);
          if (err instanceof FetchError && err.code === 'host_blocked')
            throw new TypeError(`${host} asked to wait before more requests`, { cause: err });
          throw err;
        } finally {
          const durationMs = performance.now() - started;
          span.setAttribute('rss.fetch.outcome', outcome);
          this.#ops?.recordFetch({ host, purpose: 'plugin', outcome, bytes, durationMs });
          const instruments = getInstruments();
          const attributes = { 'rss.fetch.purpose': 'plugin', 'rss.fetch.outcome': outcome };
          instruments.outboundRequests.add(1, attributes);
          instruments.outboundDuration.record(durationMs / 1000, attributes);
        }
      },
    );
  }
}

/** Reads the URL and request of `fetch`'s arguments, a global `Request` included. */
async function outgoing(
  input: string | URL | globalThis.Request,
  init: globalThis.RequestInit | undefined,
): Promise<Outgoing> {
  if (typeof input === 'string' || input instanceof URL)
    // The global types and undici's describe the same fetch, apart from undici's extras.
    return { url: new URL(input), init: (init ?? {}) as unknown as RequestInit };
  const method = init?.method ?? input.method;
  const body =
    method === 'GET' || method === 'HEAD' ? null : Buffer.from(await input.arrayBuffer());
  return {
    url: new URL(input.url),
    init: {
      method,
      headers: [...input.headers],
      body,
      ...(init as RequestInit | undefined),
    },
  };
}

/** HTTP 429, or 503 with Retry-After, pauses the host for every client, as for feed fetches. */
function pauseSeconds(response: Response): number | null {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (response.status === 429) return retryAfter ?? DEFAULT_HOST_COOLDOWN_SECONDS;
  if (response.status === 503 && retryAfter !== null) return retryAfter;
  return null;
}

function statusOutcome(status: number): FetchOutcome {
  if (status === 304) return 'not_modified';
  if (status >= 200 && status <= 399) return 'ok';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_error' : 'client_error';
}

function errorOutcome(err: unknown): FetchOutcome {
  // The polite fetcher refusing a paused host, or the address guard (as the cause).
  if (err instanceof FetchError) return 'blocked';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return 'timeout';
  if (err instanceof TypeError) return err.cause instanceof FetchError ? 'blocked' : 'network';
  return 'other';
}
