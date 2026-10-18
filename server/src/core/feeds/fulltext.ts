import { Readability } from '@mozilla/readability';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import type { Db } from '../../db/client.ts';
import { entries, fetchHosts, userEntries } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import type { Jobs } from '../jobs.ts';
import type { JobQueue, Logger } from '../ports.ts';
import { decodeBody } from './decode.ts';
import { looksLikeHtml } from './discover.ts';
import type { HostLimiter } from './host-limiter.ts';
import { type Fetcher, FetchError } from './http.ts';
import { sanitizeContent, sanitizeTitle } from './sanitize.ts';

/** Entries a job extracts for one feed source, newest first. */
const ENTRIES_PER_JOB = 20;
/** Article pages larger than this are not read. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export interface FullTextDeps {
  db: Db;
  fetcher: Fetcher;
  hosts: HostLimiter;
  queue: JobQueue<Jobs>;
  logger: Logger;
}

/** What a page says about its article, sanitised; each null when the page does not say. */
export interface Article {
  title: string | null;
  content: string | null;
  author: string | null;
  lang: string | null;
}

/** Reads the article from an HTML page with Readability; the title falls back to `<title>`. */
export function readArticle(html: string, url: string): Article {
  // linkedom implements the parts of the DOM Readability uses. Both libraries' types refer to
  // DOM types, which the server's compiler settings leave out, so they resolve to `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { document } = parseHTML(html);
  // Read before Readability, which changes the document.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const pageTitle: unknown = document.title;
  const article = new Readability(document).parse();
  return {
    title: sanitizeTitle(article?.title || (typeof pageTitle === 'string' ? pageTitle : null)),
    content: article?.content ? sanitizeContent(article.content, url) || null : null,
    author: article?.byline ? sanitizeTitle(article.byline) : null,
    lang: article?.lang?.trim().slice(0, 35) || null,
  };
}

/** Extracts the article from an HTML page; null when Readability finds none. */
export const extractArticle = (html: string, url: string): string | null =>
  readArticle(html, url).content;

/** A fetched HTML page: its address after redirects, and its text. */
export interface Page {
  url: string;
  html: string;
}

/**
 * Fetches an HTML page within the per-host limits, unless its host asked to wait. Throws a
 * DomainError: `fetch_failed` (paused host, failed fetch) or `feed_not_found` (not a web page).
 */
export async function fetchPage(
  { db, fetcher, hosts }: Pick<FullTextDeps, 'db' | 'fetcher' | 'hosts'>,
  url: string,
  purpose: 'fulltext' | 'page',
): Promise<Page> {
  const host = new URL(url).host;
  const [paused] = await db
    .select({ host: fetchHosts.host })
    .from(fetchHosts)
    .where(and(eq(fetchHosts.host, host), sql`${fetchHosts.blockedUntil} > now()`));
  if (paused) throw new DomainError('fetch_failed', 'The site asked to wait before more requests');
  const page = await hosts
    .run(host, () => fetcher.fetch(url, { purpose, accept: 'text/html', maxBytes: MAX_PAGE_BYTES }))
    .catch((err: unknown) => {
      throw err instanceof FetchError ? new DomainError('fetch_failed', err.message) : err;
    });
  const html = decodeBody(page.body, page.contentType);
  if (!looksLikeHtml(html, page.contentType))
    throw new DomainError('feed_not_found', 'The article is not a web page');
  return { url: page.url, html };
}

/**
 * Full text: the readable article from an entry's linked page, extracted with Readability and
 * sanitised like feed content, stored beside the original. Feeds opted in by any subscriber get
 * it for new entries through `entry.extract` jobs; any entry can get it on demand.
 */
export class FullTextService {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #hosts: HostLimiter;
  readonly #queue: JobQueue<Jobs>;
  readonly #logger: Logger;

  constructor(deps: FullTextDeps) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#hosts = deps.hosts;
    this.#queue = deps.queue;
    this.#logger = deps.logger;
  }

  /** Queues extraction for the source's newest entries when a subscriber opted in. */
  async queueFor(feedSourceId: number): Promise<void> {
    const result = await this.#db.execute(sql`
      SELECT 1 FROM subscriptions WHERE feed_source_id = ${feedSourceId} AND full_text LIMIT 1`);
    if (result.rows.length === 0) return;
    await this.#queue.enqueue(
      'entry.extract',
      { feedSourceId },
      { key: `extract:${String(feedSourceId)}` },
    );
  }

  /** Job: extracts the source's newest entries not tried yet, one page at a time. */
  async runJob({ feedSourceId }: Jobs['entry.extract']): Promise<void> {
    const pending = await this.#db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.feedSourceId, feedSourceId), isNull(entries.fullContentAt)))
      .orderBy(desc(entries.fetchedAt), desc(entries.id))
      .limit(ENTRIES_PER_JOB);
    for (const { id } of pending) {
      try {
        await this.#extract(id);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        this.#logger.debug({ entryId: id, err: err.message }, 'Full text not extracted');
      }
    }
  }

  /** The full text of one of the user's entries, extracting it now unless it was before. */
  async forUser(userId: number, userEntryId: number): Promise<string> {
    const [row] = await this.#db
      .select({ entryId: userEntries.entryId, fullContent: entries.fullContent })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
      .where(and(eq(userEntries.id, userEntryId), eq(userEntries.userId, userId)));
    if (!row) throw new DomainError('not_found', 'Entry not found');
    return row.fullContent ?? (await this.#extract(row.entryId));
  }

  /** Fetches and extracts the entry's page, recording the result or the failure. */
  async #extract(entryId: number): Promise<string> {
    const [entry] = await this.#db
      .select({ link: entries.link })
      .from(entries)
      .where(eq(entries.id, entryId));
    try {
      if (!entry?.link || !/^https?:\/\//i.test(entry.link))
        throw new DomainError('invalid_input', 'The article has no web address');
      const page = await fetchPage(
        { db: this.#db, fetcher: this.#fetcher, hosts: this.#hosts },
        entry.link,
        'fulltext',
      );
      const content = extractArticle(page.html, page.url);
      if (!content) throw new DomainError('feed_not_found', 'No article found on the page');
      await this.#db
        .update(entries)
        .set({ fullContent: content, fullContentAt: sql`now()`, fullContentError: null })
        .where(eq(entries.id, entryId));
      return content;
    } catch (err) {
      if (err instanceof DomainError)
        await this.#db
          .update(entries)
          .set({ fullContentAt: sql`now()`, fullContentError: err.message })
          .where(eq(entries.id, entryId));
      throw err;
    }
  }
}
