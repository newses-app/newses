import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch, type Response } from 'undici';

export type FetchErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'http_status'
  | 'network';

export class FetchError extends Error {
  override name = 'FetchError';
  readonly code: FetchErrorCode;
  readonly status: number | null;
  /** Seconds from a Retry-After header, when the server sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: FetchErrorCode,
    message: string,
    details: { status?: number; retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.code = code;
    this.status = details.status ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

export interface FetchRequest {
  etag?: string | null;
  lastModified?: string | null;
  accept?: string;
  /** Overrides the fetcher's body limit for this request; downloads stop once it is exceeded. */
  maxBytes?: number;
}

export interface FetchResult {
  /** URL after redirects. */
  url: string;
  /** URL reached through permanent redirects (301/308) only, when the first redirect was one. */
  permanentUrl: string | null;
  /** Freshness the server declared (Cache-Control max-age, else Expires). */
  maxAgeSeconds: number | null;
  status: number;
  notModified: boolean;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array;
}

export interface Fetcher {
  fetch(url: string, request?: FetchRequest): Promise<FetchResult>;
}

export interface HttpFetcherOptions {
  /** `true` allows every private address; a list allows those CIDRs (e.g. `192.168.1.0/24`). */
  allowPrivateNetworks?: boolean | string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const PRIVATE_RANGES: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

/** Statuses whose Location header is followed. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function cidrList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix] = cidr.trim().split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** HTTP client for untrusted URLs: SSRF guard, timeout, size and redirect limits. */
export class HttpFetcher implements Fetcher {
  readonly #agent: Agent;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #userAgent: string;
  readonly #isAllowed: (address: string) => boolean;

  constructor(options: HttpFetcherOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#userAgent = options.userAgent ?? 'rss-reader (self-hosted feed reader)';

    const blocked = new BlockList();
    for (const [address, prefix, family] of PRIVATE_RANGES)
      blocked.addSubnet(address, prefix, family);
    const allowAll = options.allowPrivateNetworks === true;
    const allowed = cidrList(
      Array.isArray(options.allowPrivateNetworks) ? options.allowPrivateNetworks : [],
    );
    this.#isAllowed = (address) => {
      if (allowAll) return true;
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
      const ip = mapped ?? address;
      const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      return allowed.check(ip, family) || !blocked.check(ip, family);
    };

    // Checking addresses at connect time (not before the request) defeats DNS rebinding.
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses: LookupAddress[]) => {
        if (err) {
          callback(err, '', 0);
          return;
        }
        const denied = addresses.find((a) => !this.#isAllowed(a.address));
        if (denied) {
          callback(
            new FetchError('blocked_address', `${hostname} resolves to a private address`),
            '',
            0,
          );
          return;
        }
        if (lookupOptions.all)
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
        else {
          const first = addresses[0];
          if (first) callback(null, first.address, first.family);
          else callback(new FetchError('network', `No address for ${hostname}`), '', 0);
        }
      });
    };
    this.#agent = new Agent({ connect: { lookup }, connections: 64 });
  }

  async fetch(url: string, request: FetchRequest = {}): Promise<FetchResult> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let current = this.#checkUrl(url);
    let permanentUrl: string | null = null;
    let permanentChain = true;
    for (let redirects = 0; ; redirects++) {
      const response = await this.#request(current, request, signal);
      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status) && location) {
        await response.body?.cancel();
        if (redirects >= this.#maxRedirects) {
          throw new FetchError(
            'too_many_redirects',
            `More than ${String(this.#maxRedirects)} redirects`,
          );
        }
        current = this.#checkUrl(new URL(location, current).href);
        permanentChain &&= response.status === 301 || response.status === 308;
        if (permanentChain) permanentUrl = current;
        continue;
      }
      return this.#result(current, permanentUrl, response, request, signal);
    }
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  #checkUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchError('invalid_url', `Invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new FetchError('invalid_url', `Unsupported scheme: ${parsed.protocol}`);
    }
    // IP literals skip DNS lookup, so check them here.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !this.#isAllowed(host)) {
      throw new FetchError('blocked_address', `${host} is a private address`);
    }
    return parsed.href;
  }

  async #request(url: string, request: FetchRequest, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      'user-agent': this.#userAgent,
      accept: request.accept ?? FEED_ACCEPT,
      'accept-encoding': 'gzip, deflate, br',
    };
    if (request.etag) headers['if-none-match'] = request.etag;
    if (request.lastModified) headers['if-modified-since'] = request.lastModified;
    try {
      return await fetch(url, { headers, redirect: 'manual', signal, dispatcher: this.#agent });
    } catch (err) {
      throw this.#wrap(err, signal);
    }
  }

  async #result(
    url: string,
    permanentUrl: string | null,
    response: Response,
    request: FetchRequest,
    signal: AbortSignal,
  ): Promise<FetchResult> {
    const maxBytes = request.maxBytes ?? this.#maxBytes;
    const base = {
      url,
      permanentUrl,
      maxAgeSeconds: parseMaxAge(response.headers.get('cache-control'), response.headers),
      status: response.status,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
    if (response.status === 304) {
      await response.body?.cancel();
      return { ...base, notModified: true, body: new Uint8Array() };
    }
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel();
      throw new FetchError('http_status', `HTTP ${String(response.status)}`, {
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new FetchError('too_large', `Response exceeds ${String(maxBytes)} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        // Leaving the loop by throwing cancels the stream.
        if (size > maxBytes) {
          throw new FetchError('too_large', `Response exceeds ${String(maxBytes)} bytes`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      throw this.#wrap(err, signal);
    }
    return { ...base, notModified: false, body: Buffer.concat(chunks) };
  }

  #wrap(err: unknown, signal: AbortSignal): FetchError {
    if (err instanceof FetchError) return err;
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof FetchError) return cause;
    if (signal.aborted) return new FetchError('timeout', 'Request timed out', { cause: err });
    const message =
      cause instanceof Error ? cause.message : err instanceof Error ? err.message : 'Network error';
    return new FetchError('network', message, { cause: err });
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Seconds the response stays fresh: Cache-Control max-age, else Expires minus Date. */
export function parseMaxAge(
  cacheControl: string | null,
  headers: { get(name: string): string | null },
): number | null {
  if (cacheControl) {
    if (/(^|,)\s*(no-store|no-cache)\b/i.test(cacheControl)) return null;
    const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cacheControl)?.[1];
    if (maxAge !== undefined) return Number(maxAge);
  }
  const expires = Date.parse(headers.get('expires') ?? '');
  if (Number.isNaN(expires)) return null;
  const date = Date.parse(headers.get('date') ?? '');
  return Math.max(0, Math.round((expires - (Number.isNaN(date) ? Date.now() : date)) / 1000));
}
