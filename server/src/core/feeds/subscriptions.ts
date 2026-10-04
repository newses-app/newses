import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { categories, feedSources, subscriptions, userEntries } from '../../db/schema.ts';
import { isUniqueViolation } from '../db-errors.ts';
import { DomainError } from '../errors.ts';
import { decodeBody } from './decode.ts';
import { discoverFeeds, type FeedCandidate, looksLikeHtml } from './discover.ts';
import { type Fetcher, FetchError, type FetchResult } from './http.ts';
import type { Ingester } from './ingest.ts';
import { FeedParseError, type ParsedFeed, parseFeed } from './parse.ts';
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
}

type Resolved =
  | { kind: 'feed'; url: string; feed: ParsedFeed; response: FetchResult | null }
  | { kind: 'choose'; candidates: FeedCandidate[] };

export class SubscriptionService {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #ingester: Ingester | undefined;
  readonly #updater: FeedUpdater | undefined;

  /**
   * With an ingester, subscribing to an already-fetched feed delivers its existing entries. With an
   * updater, a new feed's entries are ingested from the fetch that validated it.
   */
  constructor(db: Db, fetcher: Fetcher, ingester?: Ingester, updater?: FeedUpdater) {
    this.#db = db;
    this.#fetcher = fetcher;
    this.#ingester = ingester;
    this.#updater = updater;
  }

  /**
   * Subscribes to a feed URL, or to the feed a web page advertises. When the page advertises
   * several, returns them for the user to choose.
   */
  async subscribe(
    userId: number,
    rawUrl: string,
    categoryId: number | null = null,
  ): Promise<SubscribeResult> {
    if (categoryId !== null) await this.#assertCategory(userId, categoryId);
    const url = normalizeFeedUrl(rawUrl);
    const known = await this.#sourceByUrl(url);
    if (known)
      return { status: 'subscribed', subscription: await this.#attach(userId, known, categoryId) };

    const resolved = await this.#resolve(url, true);
    if (resolved.kind === 'choose') return { status: 'choose', candidates: resolved.candidates };
    const source = await this.#upsertSource(
      resolved.url,
      resolved.feed.title,
      resolved.feed.siteUrl,
    );
    const view = await this.#attach(userId, source, categoryId);
    if (this.#updater && resolved.response && source.lastFetchedAt === null) {
      const interval = await this.#updater.intervalSeconds(source.id);
      await this.#updater.applyFetch(source, interval, resolved.response, resolved.feed);
      return { status: 'subscribed', subscription: await this.get(userId, view.subscription.id) };
    }
    return { status: 'subscribed', subscription: view };
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
    if (changes.categoryId != null) await this.#assertCategory(userId, changes.categoryId);
    const updated = await this.#db
      .update(subscriptions)
      .set({
        ...(changes.title !== undefined && { title: changes.title }),
        ...(changes.categoryId !== undefined && { categoryId: changes.categoryId }),
        ...(changes.sortOrder !== undefined && { sortOrder: changes.sortOrder }),
        ...(changes.updateIntervalSeconds !== undefined && {
          updateIntervalSeconds: changes.updateIntervalSeconds,
        }),
        ...(changes.purgeDays !== undefined && { purgeDays: changes.purgeDays }),
      })
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
      .returning({ id: subscriptions.id });
    if (updated.length === 0) throw new DomainError('not_found', 'Subscription not found');
    return this.get(userId, id);
  }

  /** Removes the subscription and its entries, except starred and published ones. */
  async unsubscribe(userId: number, id: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const deleted = await tx
        .delete(subscriptions)
        .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
        .returning({ id: subscriptions.id });
      if (deleted.length === 0) throw new DomainError('not_found', 'Subscription not found');
      // The foreign key has already set subscription_id to null on this user's entries.
      await tx
        .delete(userEntries)
        .where(
          and(
            eq(userEntries.userId, userId),
            sql`${userEntries.subscriptionId} IS NULL`,
            eq(userEntries.starred, false),
            eq(userEntries.published, false),
          ),
        );
    });
  }

  async #resolve(url: string, allowDiscovery: boolean): Promise<Resolved> {
    let response;
    try {
      response = await this.#fetcher.fetch(url);
    } catch (err) {
      if (
        err instanceof FetchError &&
        (err.code === 'blocked_address' || err.code === 'invalid_url')
      ) {
        throw new DomainError('invalid_input', err.message);
      }
      throw new DomainError(
        'fetch_failed',
        `Could not fetch ${url}: ${err instanceof Error ? err.message : 'error'}`,
      );
    }
    const body = decodeBody(response.body, response.contentType);
    const finalUrl = normalizeFeedUrl(response.url);
    try {
      return { kind: 'feed', url: finalUrl, feed: parseFeed(body, finalUrl), response };
    } catch (err) {
      if (!(err instanceof FeedParseError)) throw err;
    }
    if (allowDiscovery && looksLikeHtml(body, response.contentType)) {
      const candidates = discoverFeeds(body, finalUrl);
      const only = candidates[0];
      if (candidates.length === 1 && only) {
        const known = await this.#sourceByUrl(normalizeFeedUrl(only.url));
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
          };
        return this.#resolve(normalizeFeedUrl(only.url), false);
      }
      if (candidates.length > 1) return { kind: 'choose', candidates };
    }
    throw new DomainError('feed_not_found', `No feed found at ${url}`);
  }

  async #sourceByUrl(url: string): Promise<FeedSourceRow | undefined> {
    const [row] = await this.#db.select().from(feedSources).where(eq(feedSources.url, url));
    return row;
  }

  async #upsertSource(
    url: string,
    title: string | null,
    siteUrl: string | null,
  ): Promise<FeedSourceRow> {
    const [row] = await this.#db
      .insert(feedSources)
      .values({ url, title, siteUrl })
      .onConflictDoUpdate({
        target: feedSources.url,
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
        throw new DomainError('conflict', 'Already subscribed to this feed');
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
