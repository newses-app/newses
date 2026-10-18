import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { plainTextToHtml } from '../entries/text.ts';
import { DomainError } from '../errors.ts';
import type { Logger, Realtime } from '../ports.ts';
import { type Article, fetchPage, readArticle } from './fulltext.ts';
import type { HostLimiter } from './host-limiter.ts';
import type { Fetcher } from './http.ts';
import { sha256 } from './ingest.ts';
import { pageGuid, pagesSourceId } from './pages.ts';
import { sanitizeContent, sanitizeTitle } from './sanitize.ts';
import { normalizePageUrl } from './url.ts';

export interface PublishPageInput {
  url: string;
  title?: string | null | undefined;
  /** Plain text. */
  text?: string | null | undefined;
}

export interface PublishedPageDeps {
  db: Db;
  fetcher: Fetcher;
  hosts: HostLimiter;
  realtime: Realtime;
  logger: Logger;
}

interface Stored extends Record<string, unknown> {
  title: string | null;
  content: string | null;
  author: string | null;
  lang: string | null;
}

/**
 * Pages from outside the user's feeds, published to their published feed. Each is the user's own
 * entry in the pages source (see `pages.ts`), read and published, with no subscription.
 */
export class PublishedPageService {
  readonly #deps: PublishedPageDeps;

  constructor(deps: PublishedPageDeps) {
    this.#deps = deps;
  }

  /**
   * Publishes a page, or updates and republishes the user's page at that address; returns the
   * user entry's id. What is given replaces what was stored; a missing title or text is read
   * from the page, else kept. A page that cannot be read is published all the same, titled with
   * its address.
   */
  async publish(userId: number, input: PublishPageInput): Promise<number> {
    const { db, realtime } = this.#deps;
    const url = normalizePageUrl(input.url);
    const title = sanitizeTitle(input.title ?? null);
    const text = input.text ? plainTextToHtml(input.text) : null;
    const content = text ? sanitizeContent(text, url) || null : null;
    const read = title === null || content === null ? await this.#read(url) : null;

    const id = await db.transaction(async (tx) => {
      const sourceId = await pagesSourceId(tx);
      const guid = pageGuid(userId, url);
      const [stored] = (
        await tx.execute<Stored>(sql`
          SELECT title, content, author, lang FROM entries
          WHERE feed_source_id = ${sourceId} AND guid = ${guid}`)
      ).rows;
      const page = {
        title: title ?? read?.title ?? stored?.title ?? url,
        content: content ?? read?.content ?? stored?.content ?? null,
        author: read?.author ?? stored?.author ?? null,
        lang: read?.lang ?? stored?.lang ?? null,
      };
      const hash = sha256(`${page.title}\n${url}\n${page.content ?? ''}`);
      // Bumping last_seen_at keeps a purge running meanwhile from deleting the entry.
      const entry = await tx.execute<{ id: string }>(sql`
        INSERT INTO entries (feed_source_id, guid, link, title, author, content, content_hash, lang,
          published_at, fetched_at, last_seen_at)
        VALUES (${sourceId}, ${guid}, ${url}, ${page.title}, ${page.author}, ${page.content},
          ${hash}, ${page.lang}, now(), now(), now())
        ON CONFLICT (feed_source_id, guid) DO UPDATE SET
          title = excluded.title, author = excluded.author, content = excluded.content,
          content_hash = excluded.content_hash, lang = excluded.lang,
          published_at = now(), last_seen_at = now()
        RETURNING id`);
      const entryId = entry.rows[0]?.id;
      if (entryId === undefined) throw new Error('Page insert returned no row');
      const userEntry = await tx.execute<{ id: string }>(sql`
        INSERT INTO user_entries (user_id, entry_id, sort_at, unread, read_at, published)
        VALUES (${userId}, ${entryId}, now(), false, now(), true)
        ON CONFLICT (user_id, entry_id) DO UPDATE SET published = true, sort_at = now()
        RETURNING id`);
      const userEntryId = userEntry.rows[0]?.id;
      if (userEntryId === undefined) throw new Error('Page user entry insert returned no row');
      return Number(userEntryId);
    });
    await realtime.publish(userId, { type: 'counters' });
    return id;
  }

  /** The page's article, or null when it cannot be fetched or read; publishing goes ahead. */
  async #read(url: string): Promise<Article | null> {
    const { logger } = this.#deps;
    try {
      const page = await fetchPage(this.#deps, url, 'page');
      return readArticle(page.html, page.url);
    } catch (err) {
      if (err instanceof DomainError) logger.debug({ url, err: err.message }, 'Page not read');
      else logger.warn({ url, err }, 'Page not read');
      return null;
    }
  }
}
