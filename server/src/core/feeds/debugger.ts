import type { FeedDebug } from '@newses/shared';
import type { Db } from '../../db/client.ts';
import { FilterSet } from '../filters/engine.ts';
import { loadCategoryParents, loadDefinitions } from '../filters/run.ts';
import type { UserRateLimiter } from '../rate-limit.ts';
import { decodeBody } from './decode.ts';
import { discoverFeeds, looksLikeHtml } from './discover.ts';
import { type Fetcher, FetchError, type FetchResult } from './http.ts';
import { MAX_ENTRIES_PER_FETCH, prepare } from './ingest.ts';
import { FeedParseError, type ParsedFeed, parseFeed } from './parse.ts';
import type { SubscriptionService } from './subscriptions.ts';

/** The response body shown, in characters. */
const MAX_BODY_CHARS = 256 * 1024;

/**
 * Why a fetch got no answer, without echoing network errors, which would let users probe hosts
 * and ports through the server.
 */
function describe(err: FetchError): NonNullable<FeedDebug['error']> {
  const messages: Record<FetchError['code'], string> = {
    invalid_url: 'Not a valid URL',
    blocked_address: 'The address is on a private network',
    too_many_redirects: 'Too many redirects',
    too_large: 'Larger than a feed may be',
    timeout: 'The site did not answer in time',
    network: 'Could not connect to the site',
    http_status: `HTTP ${String(err.status)}`,
    host_blocked: 'The site asked to wait before more requests',
  };
  return {
    code: err.code,
    message: messages[err.code],
    status: err.status,
    retryAfterSeconds: err.retryAfterSeconds,
  };
}

/**
 * The feed debugger: fetches a subscribed feed as the updater would, without validators, and
 * shows the answer, the parsed entries as ingest would store them, and which of the user's
 * filters each would match. Nothing is stored and the feed's schedule is left alone; a host that
 * answers 429 is still paused, as for any fetch.
 */
export class FeedDebugger {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #limits: UserRateLimiter;
  readonly #subscriptions: SubscriptionService;

  constructor(deps: {
    db: Db;
    /** Polite: within the per-host limits and host pauses. */
    fetcher: Fetcher;
    limits: UserRateLimiter;
    subscriptions: SubscriptionService;
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#limits = deps.limits;
    this.#subscriptions = deps.subscriptions;
  }

  async debug(userId: number, subscriptionId: number): Promise<FeedDebug> {
    const { subscription, source } = await this.#subscriptions.get(userId, subscriptionId);
    await this.#limits.take(userId, 'debug');
    const result: FeedDebug = {
      url: source.url,
      error: null,
      response: null,
      feed: null,
      parseError: null,
      discovered: [],
      entries: [],
    };
    let response: FetchResult;
    try {
      response = await this.#fetcher.fetch(source.url, { purpose: 'feed', anyStatus: true });
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      return { ...result, error: describe(err) };
    }
    const text = decodeBody(response.body, response.contentType);
    result.response = {
      status: response.status,
      url: response.url,
      permanentUrl: response.permanentUrl,
      contentType: response.contentType,
      headers: Object.entries(response.headers)
        .filter(([name]) => name !== 'set-cookie')
        .map(([name, value]) => ({ name, value })),
      bytes: response.body.byteLength,
      body: text.slice(0, MAX_BODY_CHARS),
      truncated: text.length > MAX_BODY_CHARS,
    };
    if (response.status < 200 || response.status > 299) return result;

    let feed: ParsedFeed;
    try {
      feed = parseFeed(text, source.url);
    } catch (err) {
      if (!(err instanceof FeedParseError)) throw err;
      result.parseError = err.message;
      if (looksLikeHtml(text, response.contentType))
        result.discovered = discoverFeeds(text, response.url);
      return result;
    }
    result.feed = {
      format: feed.format,
      title: feed.title,
      siteUrl: feed.siteUrl,
      ttlSeconds: feed.ttlSeconds,
    };

    const definitions = (await loadDefinitions(this.#db, [userId])).get(userId) ?? [];
    const parents = (await loadCategoryParents(this.#db, [userId])).get(userId);
    const filters = new FilterSet(definitions, parents ?? new Map<number, number | null>());
    const siteUrl = feed.siteUrl ?? source.siteUrl;
    result.entries = feed.entries.slice(0, MAX_ENTRIES_PER_FETCH).flatMap((parsed) => {
      const entry = prepare(parsed, siteUrl);
      if (!entry) return [];
      const { title, content, author, link, categories: tags } = entry;
      return [
        {
          guid: entry.guid,
          title,
          link,
          author,
          publishedAt: entry.publishedAt?.toISOString() ?? null,
          updatedAt: entry.sourceUpdatedAt?.toISOString() ?? null,
          tags,
          contentLength: content?.length ?? 0,
          filterIds: filters.matching({
            title,
            content,
            author,
            link,
            tags,
            subscriptionId: subscription.id,
            categoryId: subscription.categoryId,
          }),
        },
      ];
    });
    return result;
  }
}
