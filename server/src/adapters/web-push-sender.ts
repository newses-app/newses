import { isIP } from 'node:net';
import { SpanKind } from '@opentelemetry/api';
import { Agent, fetch } from 'undici';
import { addressFilter, FetchError, guardedLookup } from '../core/feeds/http.ts';
import { hostOf } from '../core/feeds/url.ts';
import type { FetchOutcome } from '../core/ops/recorder.ts';
import type { Logger, PushOptions, PushOutcome, PushSender, PushTarget } from '../core/ports.ts';
import { getInstruments, withSpan } from '../telemetry/index.ts';
import { encryptPayload, vapidAuthorization, vapidKeys, type VapidKeys } from './web-push.ts';

export interface WebPushSenderOptions {
  /** 32 bytes derived from the app secret, from which the VAPID key pair comes. */
  seed: Buffer;
  /** The sender's contact for push services (RFC 8292): an https or mailto URL. */
  subject: string;
  /** Private addresses push services may be reached at, as for feeds; blocked by default. */
  allowPrivateNetworks?: boolean | string[];
  logger: Logger;
  timeoutMs?: number;
}

/**
 * Posts Web Push messages to the push services devices subscribed with: browsers' vendors, or a
 * UnifiedPush distributor. Endpoints come from users, so they get the feeds' address guard. Each
 * request gets a client span and counts in the outbound metrics, not in per-host statistics.
 */
export class WebPushSender implements PushSender {
  readonly publicKey: string;
  readonly #keys: VapidKeys;
  readonly #subject: string;
  readonly #isAllowed: (address: string) => boolean;
  readonly #agent: Agent;
  readonly #logger: Logger;
  readonly #timeoutMs: number;

  constructor(options: WebPushSenderOptions) {
    this.#keys = vapidKeys(options.seed);
    this.publicKey = this.#keys.publicKey.toString('base64url');
    this.#subject = options.subject;
    this.#isAllowed = addressFilter(options.allowPrivateNetworks);
    this.#agent = new Agent({ connect: { lookup: guardedLookup(this.#isAllowed) } });
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  send(target: PushTarget, payload: string, options: PushOptions): Promise<PushOutcome> {
    const host = hostOf(target.endpoint);
    return withSpan(
      `POST ${host}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': 'POST',
          'server.address': host,
          'rss.fetch.purpose': 'push',
        },
      },
      async (span) => {
        const started = performance.now();
        let outcome: FetchOutcome = 'other';
        try {
          const status = await this.#post(target, payload, options);
          span.setAttribute('http.response.status_code', status);
          outcome = fetchOutcome(status);
          if (status >= 200 && status <= 299) return 'sent';
          if (status === 404 || status === 410) return 'gone';
          this.#logger.warn({ host, status }, 'Push service refused a message');
          return 'failed';
        } catch (err) {
          outcome =
            err instanceof FetchError && err.code === 'blocked_address' ? 'blocked' : 'network';
          if (err instanceof Error && err.name === 'TimeoutError') outcome = 'timeout';
          span.setAttribute('error.type', outcome);
          this.#logger.warn({ host, err }, 'Push service could not be reached');
          return 'failed';
        } finally {
          span.setAttribute('rss.fetch.outcome', outcome);
          const instruments = getInstruments();
          const attributes = { 'rss.fetch.purpose': 'push', 'rss.fetch.outcome': outcome };
          instruments.outboundRequests.add(1, attributes);
          instruments.outboundDuration.record((performance.now() - started) / 1000, attributes);
        }
      },
    );
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  async #post(target: PushTarget, payload: string, options: PushOptions): Promise<number> {
    // The API only takes https endpoints.
    const url = new URL(target.endpoint);
    // IP literals skip DNS lookup, so check them here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !this.#isAllowed(literal))
      throw new FetchError('blocked_address', `${literal} is a private address`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(url.href, this.#keys, this.#subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(options.ttlSeconds),
        topic: options.topic,
        urgency: 'normal',
      },
      body: encryptPayload(Buffer.from(payload), target),
      // Push services answer directly; a redirect could only point somewhere unchecked.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
      dispatcher: this.#agent,
    });
    await response.body?.cancel();
    return response.status;
  }
}

function fetchOutcome(status: number): FetchOutcome {
  if (status >= 200 && status <= 299) return 'ok';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_error' : 'client_error';
}
