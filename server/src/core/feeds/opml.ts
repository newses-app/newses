import { eq, sql } from 'drizzle-orm';
import { generateOpml, parseOpml, type Opml } from 'feedsmith';
import type { Db } from '../../db/client.ts';
import { categories, feedSources, subscriptions } from '../../db/schema.ts';
import type { CategoryService } from '../categories.ts';
import { DomainError } from '../errors.ts';
import type { SubscriptionService } from './subscriptions.ts';
import { httpUrl, normalizeFeedUrl } from './url.ts';

export interface OpmlImportResult {
  categoriesCreated: number;
  subscribed: number;
  alreadySubscribed: number;
  invalid: { url: string; reason: string }[];
}

type Outline = Opml.Outline<string>;

/** Top-level outlines TTRSS adds to its OPML exports for preferences, labels, and filters. */
const TTRSS_SECTIONS = new Set(['tt-rss-prefs', 'tt-rss-labels', 'tt-rss-filters']);

export class OpmlService {
  readonly #db: Db;
  readonly #categories: CategoryService;
  readonly #subscriptions: SubscriptionService;

  constructor(db: Db, categoryService: CategoryService, subscriptionService: SubscriptionService) {
    this.#db = db;
    this.#categories = categoryService;
    this.#subscriptions = subscriptionService;
  }

  /**
   * Imports feeds and nested categories. Existing categories (same name and parent) and
   * subscriptions are reused, so importing the same file twice changes nothing.
   * Feeds are not fetched here; the updater fetches them.
   */
  async import(userId: number, xml: string): Promise<OpmlImportResult> {
    let outlines: Outline[];
    try {
      outlines = parseOpml(xml).body?.outlines ?? [];
    } catch {
      throw new DomainError('invalid_input', 'Not a valid OPML document');
    }
    const result: OpmlImportResult = {
      categoriesCreated: 0,
      subscribed: 0,
      alreadySubscribed: 0,
      invalid: [],
    };

    await this.#db.transaction(async (tx) => {
      const existing = await tx.select().from(categories).where(eq(categories.userId, userId));
      const key = (parentId: number | null, title: string) => `${String(parentId)}\u0000${title}`;
      const categoryIds = new Map(existing.map((c) => [key(c.parentId, c.title), c.id]));

      const walk = async (items: Outline[], parentId: number | null): Promise<void> => {
        for (const [index, outline] of items.entries()) {
          const title = (outline.title ?? outline.text ?? '').trim();
          if (outline.xmlUrl) {
            let url: string;
            try {
              url = normalizeFeedUrl(outline.xmlUrl);
            } catch (err) {
              result.invalid.push({
                url: outline.xmlUrl,
                reason: err instanceof Error ? err.message : 'invalid',
              });
              continue;
            }
            const [source] = await tx
              .insert(feedSources)
              .values({ url, title: title || null, siteUrl: httpUrl(outline.htmlUrl) })
              .onConflictDoUpdate({ target: feedSources.url, set: { url: sql`excluded.url` } })
              .returning({ id: feedSources.id });
            if (!source) throw new Error('Feed source upsert returned no row');
            const inserted = await tx
              .insert(subscriptions)
              .values({ userId, feedSourceId: source.id, categoryId: parentId, sortOrder: index })
              .onConflictDoNothing()
              .returning({ id: subscriptions.id });
            if (inserted.length > 0) result.subscribed++;
            else result.alreadySubscribed++;
            continue;
          }
          if (parentId === null && TTRSS_SECTIONS.has(outline.text ?? '')) continue;
          if (!title) {
            await walk(outline.outlines ?? [], parentId);
            continue;
          }
          let categoryId = categoryIds.get(key(parentId, title));
          if (categoryId === undefined) {
            const [created] = await tx
              .insert(categories)
              .values({ userId, parentId, title, sortOrder: index })
              .returning({ id: categories.id });
            if (!created) throw new Error('Category insert returned no row');
            categoryId = created.id;
            categoryIds.set(key(parentId, title), categoryId);
            result.categoriesCreated++;
          }
          await walk(outline.outlines ?? [], categoryId);
        }
      };
      await walk(outlines, null);
    });
    return result;
  }

  async export(userId: number): Promise<string> {
    const [allCategories, allSubscriptions] = await Promise.all([
      this.#categories.list(userId),
      this.#subscriptions.list(userId),
    ]);
    const feedOutlines = (categoryId: number | null): Outline[] =>
      allSubscriptions
        .filter(({ subscription }) => subscription.categoryId === categoryId)
        .map(({ subscription, source }) => {
          const title = subscription.title ?? source.title ?? source.url;
          return {
            type: 'rss',
            text: title,
            title,
            xmlUrl: source.url,
            ...(source.siteUrl && { htmlUrl: source.siteUrl }),
          };
        });
    const categoryOutlines = (parentId: number | null): Outline[] =>
      allCategories
        .filter((c) => c.parentId === parentId)
        .map((c) => ({
          text: c.title,
          title: c.title,
          outlines: [...categoryOutlines(c.id), ...feedOutlines(c.id)],
        }));

    return generateOpml({
      head: { title: 'rss-reader subscriptions', dateCreated: new Date() },
      body: { outlines: [...categoryOutlines(null), ...feedOutlines(null)] },
    });
  }
}
