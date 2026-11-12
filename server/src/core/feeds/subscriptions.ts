import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { categories, feedSources, subscriptions } from '../../db/schema.ts';
import { isUniqueViolation } from '../db-errors.ts';
import {
  MAX_FEED_TITLE_LENGTH,
  MAX_FEED_URL_LENGTH,
  MAX_SUBSCRIPTION_TITLE_LENGTH,
} from '@newses/shared';
import { CryptoError } from '../crypto.ts';
import { assertMaxLength, DomainError, ThrottledError } from '../errors.ts';
import type { UserRateLimiter } from '../rate-limit.ts';
import {
  credentialOrigin,
  type FeedCredentials,
  type FeedCredentialSealer,
} from './credentials.ts';
import { decodeBody } from './decode.ts';
import { discoverFeeds, type FeedCandidate, looksLikeHtml } from './discover.ts';
import { describeFetchFailure } from './fetch-failure.ts';
import { type Fetcher, FetchError, type FetchResult } from './http.ts';
import type { Ingester } from './ingest.ts';
import { FeedParseError, type ParsedFeed, parseFeed } from './parse.ts';
import { KEPT_ENTRY } from './purge.ts';
import type { FeedUpdater } from './updater.ts';
import { normalizeFeedUrl } from './url.ts';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type FeedSourceRow = typeof feedSources.$inferSelect;

export interface SubscriptionView {
  subscription: SubscriptionRow;
  source: FeedSourceRow;
}

export type SubscribeResult =
  | { status: 'subscribed'; subscription: SubscriptionView }
  | { status: 'choose'; candidates: FeedCandidate[] };

export interface SubscriptionChanges {
  title?: string | null;
  categoryId?: number | null;
  sortOrder?: number;
  updateIntervalSeconds?: number | null;
  purgeDays?: number | null;
  fullText?: boolean;
  paused?: boolean;
  hideFromAll?: boolean;
  /** Null removes them; without a password, the stored one is kept. */
  credentials?: { login: string; password?: string | undefined } | null;
}

type Resolved =
  | {
      kind: 'feed';
      url: string;
      feed: ParsedFeed;
      response: FetchResult | null;
      /** The address fetched with the credentials, when they were sent. */
      authenticatedUrl: string | null;
    }
  | { kind: 'choose'; candidates: FeedCandidate[] };

export class SubscriptionService {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #ingester: Ingester | undefined;
  readonly #updater: FeedUpdater | undefined;
  readonly #limits: UserRateLimiter | undefined;
  readonly #sealer: FeedCredentialSealer;

  /**
   * With an ingester, subscribing to an already-fetched feed delivers its existing entries. With an
   * updater, a new feed's entries are ingested from the fetch that validated it. With limits,
   * each user's subscribes to new feeds are rate limited.
   */
  constructor(deps: {
    db: Db;
    /** Polite: within the per-host limits and host pauses. */
    fetcher: Fetcher;
    /** Seals the passwords of feeds with credentials. */
    sealer: FeedCredentialSealer;
    ingester?: Ingester;
    updater?: FeedUpdater;
    limits?: UserRateLimiter;
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#sealer = deps.sealer;
    this.#ingester = deps.ingester;
    this.#updater = deps.updater;
    this.#limits = deps.limits;
  }

  /**
   * Subscribes to a feed URL, or to the feed a web page advertises. When the page advertises
   * several, returns them for the user to choose. With credentials, the subscription gets a feed
   * source of its own, fetched with them.
   */
  async subscribe(
    userId: number,
    rawUrl: string,
    categoryId: number | null = null,
    credentials: FeedCredentials | null = null,
  ): Promise<SubscribeResult> {
    assertMaxLength(rawUrl, MAX_FEED_URL_LENGTH, 'A feed address');
    if (categoryId !== null) await this.#assertCategory(userId, categoryId);
    const url = normalizeFeedUrl(rawUrl);
    if (credentials) return this.#subscribeWithCredentials(userId, url, categoryId, credentials);
    const known = await this.#sourceByUrl(url);
    if (known) {
      const view = await this.#attach(userId, known, categoryId);
      await this.#updater?.reschedule([known.id]);
      return { status: 'subscribed', subscription: await this.get(userId, view.subscription.id) };
    }

    // Once per subscribe, though discovery may fetch twice.
    await this.#limits?.take(userId, 'subscribe');
    const resolved = await this.#resolve(url, true);
    if (resolved.kind === 'choose') return { status: 'choose', candidates: resolved.candidates };
    const source = await this.#upsertSource(
      resolved.url,
      resolved.feed.title,
      resolved.feed.siteUrl,
    );
    const view = await this.#attach(userId, source, categoryId);
    if (this.#updater && resolved.response && source.lastFetchedAt === null) {
      await this.#updater.applyFetch(source, resolved.response, resolved.feed);
      return { status: 'subscribed', subscription: await this.get(userId, view.subscription.id) };
    }
    return { status: 'subscribed', subscription: view };
  }

  async #subscribeWithCredentials(
    userId: number,
    url: string,
    categoryId: number | null,
    credentials: FeedCredentials,
  ): Promise<SubscribeResult> {
    await this.#assertNotSubscribed(userId, url);
    await this.#limits?.take(userId, 'subscribe');
    const resolved = await this.#resolve(url, true, credentials);
    if (resolved.kind === 'choose') return { status: 'choose', candidates: resolved.candidates };
    const feedUrl = authenticatedFeedUrl(resolved);
    const source = await this.#createOwnSource(feedUrl, resolved.feed, credentials);
    let view: SubscriptionView;
    try {
      view = await this.#attach(userId, source, categoryId);
    } catch (err) {
      await this.#db.delete(feedSources).where(eq(feedSources.id, source.id));
      throw err;
    }
    if (this.#updater && resolved.response)
      await this.#updater.applyFetch(source, resolved.response, resolved.feed);
    return { status: 'subscribed', subscription: await this.get(userId, view.subscription.id) };
  }

  list(userId: number): Promise<SubscriptionView[]> {
    return this.#db
      .select({ subscription: subscriptions, source: feedSources })
      .from(subscriptions)
      .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
      .where(eq(subscriptions.userId, userId))
      .orderBy(
        asc(subscriptions.sortOrder),
        asc(sql`lower(coalesce(${subscriptions.title}, ${feedSources.title}, ${feedSources.url}))`),
      );
  }

  async get(userId: number, id: number): Promise<SubscriptionView> {
    const [row] = await this.#db
      .select({ subscription: subscriptions, source: feedSources })
      .from(subscriptions)
      .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)));
    if (!row) throw new DomainError('not_found', 'Subscription not found');
    return row;
  }

  async update(
    userId: number,
    id: number,
    changes: SubscriptionChanges,
  ): Promise<SubscriptionView> {
    assertMaxLength(changes.title, MAX_SUBSCRIPTION_TITLE_LENGTH, "A feed's title");
    if (changes.categoryId != null) await this.#assertCategory(userId, changes.categoryId);
    if (changes.credentials !== undefined)
      await this.#changeCredentials(userId, id, changes.credentials);
    const values = {
      ...(changes.title !== undefined && { title: changes.title }),
      ...(changes.categoryId !== undefined && { categoryId: changes.categoryId }),
      ...(changes.sortOrder !== undefined && { sortOrder: changes.sortOrder }),
      ...(changes.updateIntervalSeconds !== undefined && {
        updateIntervalSeconds: changes.updateIntervalSeconds,
      }),
      ...(changes.purgeDays !== undefined && { purgeDays: changes.purgeDays }),
      ...(changes.fullText !== undefined && { fullText: changes.fullText }),
      ...(changes.paused !== undefined && { paused: changes.paused }),
      ...(changes.hideFromAll !== undefined && { hideFromAll: changes.hideFromAll }),
    };
    if (Object.keys(values).length === 0) return this.get(userId, id);
    const [row] = await this.#db
      .update(subscriptions)
      .set(values)
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
      .returning({ feedSourceId: subscriptions.feedSourceId });
    if (!row) throw new DomainError('not_found', 'Subscription not found');
    if (changes.updateIntervalSeconds !== undefined || changes.paused !== undefined)
      await this.#updater?.reschedule([row.feedSourceId]);
    return this.get(userId, id);
  }

  /** Removes the subscription and its entries, except kept ones (see `KEPT_ENTRY`). */
  async unsubscribe(userId: number, id: number): Promise<void> {
    const feedSourceId = await this.#db.transaction(async (tx) => {
      // Before the subscription goes, while its entries can be told from other entries without
      // one (pages, earlier unsubscriptions); the foreign key then clears it on the kept ones.
      await tx.execute(sql`
        DELETE FROM user_entries ue
        WHERE ue.user_id = ${userId} AND ue.subscription_id = ${id} AND NOT ${KEPT_ENTRY}`);
      const [deleted] = await tx
        .delete(subscriptions)
        .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
        .returning({ feedSourceId: subscriptions.feedSourceId });
      if (!deleted) throw new DomainError('not_found', 'Subscription not found');
      return deleted.feedSourceId;
    });
    await this.#updater?.reschedule([feedSourceId]);
  }

  /**
   * Changes a subscription's credentials. New ones are tried first, and nothing changes when the
   * feed refuses them. Adding or removing them moves the subscription to a new source of its own,
   * or to the one shared by its URL; the source it leaves is never shared with anyone else.
   */
  async #changeCredentials(
    userId: number,
    id: number,
    given: NonNullable<SubscriptionChanges['credentials']> | null,
  ): Promise<void> {
    const { subscription, source } = await this.get(userId, id);
    if (given === null) {
      if (source.authLogin === null) return;
      const shared =
        (await this.#sourceByUrl(source.url)) ??
        (await this.#upsertSource(source.url, source.title, source.siteUrl));
      await this.#move(subscription, source.id, shared.id);
      return;
    }
    const credentials = { login: given.login, password: given.password ?? this.#stored(source) };
    await this.#limits?.take(userId, 'subscribe');
    const resolved = await this.#resolve(source.url, false, credentials);
    if (resolved.kind === 'choose') throw new Error('Resolving without discovery chose');
    if (source.authLogin !== null) {
      const [updated] = await this.#db
        .update(feedSources)
        .set({
          authLogin: credentials.login,
          authPassword: this.#sealer.seal(source.id, credentials.password),
          disabledAt: null,
        })
        .where(eq(feedSources.id, source.id))
        .returning();
      if (updated && resolved.response)
        await this.#updater?.applyFetch(updated, resolved.response, resolved.feed);
      return;
    }
    const own = await this.#createOwnSource(
      authenticatedFeedUrl(resolved),
      resolved.feed,
      credentials,
    );
    await this.#move(subscription, source.id, own.id);
    if (resolved.response) await this.#updater?.applyFetch(own, resolved.response, resolved.feed);
  }

  /** The source's stored password, for new credentials given without one. */
  #stored(source: FeedSourceRow): string {
    if (source.authLogin === null)
      throw new DomainError('invalid_input', 'A password is needed for a feed without one');
    try {
      return this.#sealer.open(source)?.password ?? '';
    } catch (err) {
      if (!(err instanceof CryptoError)) throw err;
      throw new DomainError('invalid_input', "The feed's saved password cannot be read", {
        reason: 'feed_login_unreadable',
      });
    }
  }

  /**
   * Points the subscription at another source. Its entries there arrive as new; of those it had,
   * only kept ones stay (see `KEPT_ENTRY`), outside any feed, as when unsubscribing.
   */
  async #move(subscription: SubscriptionRow, fromId: number, toId: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM user_entries ue
        WHERE ue.user_id = ${subscription.userId} AND ue.subscription_id = ${subscription.id}
          AND NOT ${KEPT_ENTRY}`);
      await tx.execute(sql`
        UPDATE user_entries SET subscription_id = NULL
        WHERE user_id = ${subscription.userId} AND subscription_id = ${subscription.id}`);
      await tx
        .update(subscriptions)
        .set({ feedSourceId: toId })
        .where(eq(subscriptions.id, subscription.id));
    });
    await this.#ingester?.backfill(subscription.id);
    await this.#updater?.reschedule([fromId, toId]);
  }

  /** A source of one subscription's own, with its password sealed under its id. */
  async #createOwnSource(
    url: string,
    feed: ParsedFeed,
    credentials: FeedCredentials,
  ): Promise<FeedSourceRow> {
    return this.#db.transaction(async (tx) => {
      const [created] = await tx
        .insert(feedSources)
        .values({
          url,
          title: feed.title?.slice(0, MAX_FEED_TITLE_LENGTH) ?? null,
          siteUrl: feed.siteUrl,
          authLogin: credentials.login,
        })
        .returning({ id: feedSources.id });
      if (!created) throw new Error('Feed source insert returned no row');
      const [row] = await tx
        .update(feedSources)
        .set({ authPassword: this.#sealer.seal(created.id, credentials.password) })
        .where(eq(feedSources.id, created.id))
        .returning();
      if (!row) throw new Error('Feed source update returned no row');
      return row;
    });
  }

  /**
   * Fetches `url`, and with discovery the feed a page advertises. Credentials go to the URL's
   * origin only, and to a discovered feed only on the same origin.
   */
  async #resolve(
    url: string,
    allowDiscovery: boolean,
    credentials: FeedCredentials | null = null,
  ): Promise<Resolved> {
    let response;
    try {
      response = await this.#fetcher.fetch(url, { purpose: 'subscribe', credentials });
    } catch (err) {
      throw fetchFailure(url, err);
    }
    const body = decodeBody(response.body, response.contentType);
    const finalUrl = normalizeFeedUrl(response.url);
    const authenticatedUrl = credentials ? url : null;
    try {
      return {
        kind: 'feed',
        url: finalUrl,
        feed: parseFeed(body, finalUrl),
        response,
        authenticatedUrl,
      };
    } catch (err) {
      if (!(err instanceof FeedParseError)) throw err;
    }
    if (allowDiscovery && looksLikeHtml(body, response.contentType)) {
      const candidates = discoverFeeds(body, finalUrl);
      const only = candidates[0];
      if (candidates.length === 1 && only) {
        const candidateUrl = normalizeFeedUrl(only.url);
        if (credentials)
          return this.#resolve(
            candidateUrl,
            false,
            credentialOrigin(candidateUrl) === credentialOrigin(url) ? credentials : null,
          );
        const known = await this.#sourceByUrl(candidateUrl);
        if (known)
          return {
            kind: 'feed',
            url: known.url,
            feed: {
              format: 'rss',
              title: known.title,
              siteUrl: known.siteUrl,
              ttlSeconds: known.ttlSeconds,
              entries: [],
            },
            response: null,
            authenticatedUrl: null,
          };
        return this.#resolve(candidateUrl, false);
      }
      if (candidates.length > 1) return { kind: 'choose', candidates };
    }
    throw new DomainError('feed_not_found', `No feed found at ${url}`, {
      reason: 'no_feed_found',
      params: { url },
    });
  }

  /** The shared source of `url`; sources with credentials are never found by URL. */
  async #sourceByUrl(url: string): Promise<FeedSourceRow | undefined> {
    const [row] = await this.#db
      .select()
      .from(feedSources)
      .where(and(eq(feedSources.url, url), isNull(feedSources.authLogin)));
    return row;
  }

  /** A user has one subscription per feed URL, with credentials or without. */
  async #assertNotSubscribed(userId: number, url: string): Promise<void> {
    const [row] = await this.#db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
      .where(and(eq(subscriptions.userId, userId), eq(feedSources.url, url)))
      .limit(1);
    if (row)
      throw new DomainError('conflict', 'Already subscribed to this feed', {
        reason: 'already_subscribed',
      });
  }

  async #upsertSource(
    url: string,
    title: string | null,
    siteUrl: string | null,
  ): Promise<FeedSourceRow> {
    const [row] = await this.#db
      .insert(feedSources)
      // Titles come from the feed, so they are cut rather than refused.
      .values({ url, title: title?.slice(0, MAX_FEED_TITLE_LENGTH) ?? null, siteUrl })
      .onConflictDoUpdate({
        target: feedSources.url,
        targetWhere: isNull(feedSources.authLogin),
        set: {
          title: sql`coalesce(${feedSources.title}, excluded.title)`,
          siteUrl: sql`coalesce(${feedSources.siteUrl}, excluded.site_url)`,
        },
      })
      .returning();
    if (!row) throw new Error('Feed source upsert returned no row');
    return row;
  }

  async #attach(
    userId: number,
    source: FeedSourceRow,
    categoryId: number | null,
  ): Promise<SubscriptionView> {
    await this.#assertNotSubscribed(userId, source.url);
    try {
      const [subscription] = await this.#db
        .insert(subscriptions)
        .values({ userId, feedSourceId: source.id, categoryId })
        .returning();
      if (!subscription) throw new Error('Subscription insert returned no row');
      await this.#ingester?.backfill(subscription.id);
      return { subscription, source };
    } catch (err) {
      if (isUniqueViolation(err))
        throw new DomainError('conflict', 'Already subscribed to this feed', {
          reason: 'already_subscribed',
        });
      throw err;
    }
  }

  async #assertCategory(userId: number, categoryId: number): Promise<void> {
    const [row] = await this.#db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));
    if (!row) throw new DomainError('not_found', 'Category not found');
  }
}

/**
 * The URL a source with credentials keeps: where the feed was found, unless that is on another
 * origin than the credentials were sent to, as they must never follow it there. A feed whose
 * credentials were not sent at all (a discovered feed on another site) is refused.
 */
function authenticatedFeedUrl(resolved: Extract<Resolved, { kind: 'feed' }>): string {
  const sent = resolved.authenticatedUrl;
  if (sent === null)
    throw new DomainError('invalid_input', 'The feed is on another site than the login is for', {
      reason: 'feed_login_elsewhere',
      params: { url: resolved.url },
    });
  return credentialOrigin(resolved.url) === credentialOrigin(sent) ? resolved.url : sent;
}

/** Why a URL could not be subscribed. */
function fetchFailure(url: string, err: unknown): DomainError {
  if (!(err instanceof FetchError))
    return new DomainError('fetch_failed', `Could not fetch ${url}`, {
      reason: 'fetch_network',
      params: { url },
    });
  const { message, detail } = describeFetchFailure(url, err);
  switch (err.code) {
    case 'invalid_url':
    case 'blocked_address':
      return new DomainError('invalid_input', message, detail);
    case 'host_blocked':
      return new ThrottledError(err.retryAfterSeconds ?? 60, message, detail);
    default:
      return new DomainError('fetch_failed', message, detail);
  }
}
