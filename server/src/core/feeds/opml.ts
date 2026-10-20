import { eq, sql } from 'drizzle-orm';
import { generateOpml, parseOpml, type Opml } from 'feedsmith';
import type { Db } from '../../db/client.ts';
import { categories, feedSources, subscriptions } from '../../db/schema.ts';
import type { CategoryService } from '../categories.ts';
import {
  MAX_CATEGORY_TITLE_LENGTH,
  MAX_FEED_TITLE_LENGTH,
  MAX_FEED_URL_LENGTH,
  MAX_OPML_DEPTH,
  MAX_OPML_OUTLINES,
} from '@newses/shared';
import { assertMaxLength, DomainError } from '../errors.ts';
import type { UserRateLimiter } from '../rate-limit.ts';
import type { SubscriptionService } from './subscriptions.ts';
import { httpUrl, normalizeFeedUrl } from './url.ts';

export interface OpmlImportResult {
  categoriesCreated: number;
  subscribed: number;
  alreadySubscribed: number;
  invalid: { url: string; reason: string }[];
}

type Outline = Opml.Outline<string>;

/** A titled folder of the file, which becomes a category. */
interface Folder {
  title: string;
  parent: Folder | null;
  depth: number;
  index: number;
}

interface Feed {
  url: string;
  title: string;
  siteUrl: string | null;
  parent: Folder | null;
  index: number;
}

/**
 * The file's folders and feeds in document order, and the feeds whose URLs are invalid. Untitled
 * folders are flattened into their parent; TTRSS's own sections are skipped. Throws when the file
 * is over the limits, before anything is written.
 */
function readOutlines(outlines: Outline[]) {
  const folders: Folder[] = [];
  const feeds: Feed[] = [];
  const invalid: OpmlImportResult['invalid'] = [];
  let count = 0;
  const walk = (items: Outline[], parent: Folder | null, nesting: number) => {
    if (nesting > MAX_OPML_DEPTH)
      throw new DomainError(
        'invalid_input',
        `Folders are nested more than ${String(MAX_OPML_DEPTH)} deep`,
      );
    for (const [index, outline] of items.entries()) {
      if (parent === null && TTRSS_SECTIONS.has(outline.text ?? '')) continue;
      if (++count > MAX_OPML_OUTLINES)
        throw new DomainError(
          'invalid_input',
          `At most ${String(MAX_OPML_OUTLINES)} feeds and folders can be imported at once`,
        );
      const title = (outline.title ?? outline.text ?? '').trim();
      if (outline.xmlUrl) {
        try {
          assertMaxLength(outline.xmlUrl, MAX_FEED_URL_LENGTH, 'The address');
          const url = normalizeFeedUrl(outline.xmlUrl);
          const named = title.slice(0, MAX_FEED_TITLE_LENGTH);
          feeds.push({ url, title: named, siteUrl: httpUrl(outline.htmlUrl), parent, index });
        } catch (err) {
          invalid.push({
            url: outline.xmlUrl.slice(0, MAX_FEED_URL_LENGTH),
            reason: err instanceof Error ? err.message : 'invalid',
          });
        }
        continue;
      }
      if (!title) {
        walk(outline.outlines ?? [], parent, nesting + 1);
        continue;
      }
      // Names are cut to fit, as the TTRSS importer does, rather than failing the import.
      const name = title.slice(0, MAX_CATEGORY_TITLE_LENGTH).trim();
      const folder = { title: name, parent, depth: (parent?.depth ?? 0) + 1, index };
      folders.push(folder);
      walk(outline.outlines ?? [], folder, nesting + 1);
    }
  };
  walk(outlines, null, 1);
  return { folders, feeds, invalid };
}

/** Top-level outlines TTRSS adds to its OPML exports for preferences, labels, and filters. */
const TTRSS_SECTIONS = new Set(['tt-rss-prefs', 'tt-rss-labels', 'tt-rss-filters']);

export class OpmlService {
  readonly #db: Db;
  readonly #categories: CategoryService;
  readonly #subscriptions: SubscriptionService;
  readonly #limits: UserRateLimiter | undefined;

  /** With limits, each user's imports are rate limited. */
  constructor(
    db: Db,
    categoryService: CategoryService,
    subscriptionService: SubscriptionService,
    limits?: UserRateLimiter,
  ) {
    this.#db = db;
    this.#categories = categoryService;
    this.#subscriptions = subscriptionService;
    this.#limits = limits;
  }

  /**
   * Imports feeds and nested categories. Existing categories (same name and parent) and
   * subscriptions are reused, so importing the same file twice changes nothing.
   * Feeds are not fetched here; the updater fetches them. Files with more than MAX_OPML_OUTLINES
   * feeds and folders, or folders nested deeper than MAX_OPML_DEPTH, are refused whole.
   */
  async import(userId: number, xml: string): Promise<OpmlImportResult> {
    await this.#limits?.take(userId, 'import');
    let outlines: Outline[];
    try {
      outlines = parseOpml(xml).body?.outlines ?? [];
    } catch {
      throw new DomainError('invalid_input', 'Not a valid OPML document');
    }
    const { folders, feeds, invalid } = readOutlines(outlines);
    const result: OpmlImportResult = {
      categoriesCreated: 0,
      subscribed: 0,
      alreadySubscribed: 0,
      invalid,
    };

    await this.#db.transaction(async (tx) => {
      const existing = await tx.select().from(categories).where(eq(categories.userId, userId));
      const key = (parentId: number | null, title: string) => `${String(parentId)}\u0000${title}`;
      const categoryIds = new Map(existing.map((c) => [key(c.parentId, c.title), c.id]));
      const folderIds = new Map<Folder, number | null>();
      const idOf = (folder: Folder | null) => (folder ? (folderIds.get(folder) ?? null) : null);

      // Folders a level at a time, so each level knows its parents' ids.
      for (let depth = 1; depth <= MAX_OPML_DEPTH; depth++) {
        const level = folders.filter((folder) => folder.depth === depth);
        const missing = new Map<string, { parentId: number | null; folder: Folder }>();
        for (const folder of level) {
          const parentId = idOf(folder.parent);
          const id = categoryIds.get(key(parentId, folder.title));
          if (id !== undefined) folderIds.set(folder, id);
          else if (!missing.has(key(parentId, folder.title)))
            missing.set(key(parentId, folder.title), { parentId, folder });
        }
        if (missing.size > 0) {
          const created = await tx
            .insert(categories)
            .values(
              [...missing.values()].map(({ parentId, folder }) => ({
                userId,
                parentId,
                title: folder.title,
                sortOrder: folder.index,
              })),
            )
            .returning({
              id: categories.id,
              parentId: categories.parentId,
              title: categories.title,
            });
          for (const row of created) categoryIds.set(key(row.parentId, row.title), row.id);
          result.categoriesCreated += created.length;
        }
        for (const folder of level)
          folderIds.set(folder, categoryIds.get(key(idOf(folder.parent), folder.title)) ?? null);
      }
      if (feeds.length === 0) return;

      // One row per URL, as an upsert may not touch a row twice; the first outline names it.
      const sources = new Map<string, Feed>();
      for (const feed of feeds) if (!sources.has(feed.url)) sources.set(feed.url, feed);
      const rows = await tx
        .insert(feedSources)
        .values(
          [...sources.values()].map((feed) => ({
            url: feed.url,
            title: feed.title || null,
            siteUrl: feed.siteUrl,
          })),
        )
        .onConflictDoUpdate({ target: feedSources.url, set: { url: sql`excluded.url` } })
        .returning({ id: feedSources.id, url: feedSources.url });
      const sourceIds = new Map(rows.map((row) => [row.url, row.id]));
      const inserted = await tx
        .insert(subscriptions)
        .values(
          feeds.map((feed) => ({
            userId,
            feedSourceId: sourceIds.get(feed.url) ?? 0,
            categoryId: idOf(feed.parent),
            sortOrder: feed.index,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: subscriptions.id });
      result.subscribed = inserted.length;
      result.alreadySubscribed = feeds.length - inserted.length;
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
      head: { title: 'Newses subscriptions', dateCreated: new Date() },
      body: { outlines: [...categoryOutlines(null), ...feedOutlines(null)] },
    });
  }
}
