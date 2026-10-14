import { and, eq, sql } from 'drizzle-orm';
import { Parser } from 'htmlparser2';
import type { Db } from '../../db/client.ts';
import { sign, verify } from '../crypto.ts';
import { feedSources, subscriptions } from '../../db/schema.ts';
import type { Blob, BlobStore, Logger } from '../ports.ts';
import { decodeBody } from './decode.ts';
import type { HostLimiter } from './host-limiter.ts';
import { imageContentType } from './image-type.ts';
import type { Fetcher, FetchRequest, FetchResult } from './http.ts';

const MAX_ICON_BYTES = 256 * 1024;
/** Icon links sit in <head>, so the rest of a large page is not downloaded. */
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_CANDIDATES = 3;
/** An icon another feed of the same site fetched this recently is reused instead of refetched. */
const REUSE_DAYS = 30;
const ICON_RELS = ['icon', 'shortcut', 'apple-touch-icon'];

export const faviconKey = (feedSourceId: number) => `favicons/${String(feedSourceId)}`;

/** Icon URLs a page declares, best first, then /favicon.ico. */
export function iconCandidates(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name !== 'link' || !attributes.href) return;
      const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
      if (!rel.some((r) => ICON_RELS.includes(r))) return;
      try {
        found.push(new URL(attributes.href, pageUrl).href);
      } catch {
        // Ignore malformed hrefs.
      }
    },
  });
  parser.end(html);
  found.push(new URL('/favicon.ico', pageUrl).href);
  return [...new Set(found)];
}

export class FaviconService {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #blobs: BlobStore;
  readonly #logger: Logger;
  readonly #hosts: HostLimiter;

  constructor(db: Db, fetcher: Fetcher, blobs: BlobStore, logger: Logger, hosts: HostLimiter) {
    this.#db = db;
    this.#fetcher = fetcher;
    this.#blobs = blobs;
    this.#logger = logger;
    this.#hosts = hosts;
  }

  /** Finds and stores the site's icon. Failures leave the previous icon and are retried later. */
  async refresh(feedSourceId: number): Promise<void> {
    const [source] = await this.#db
      .select()
      .from(feedSources)
      .where(eq(feedSources.id, feedSourceId));
    if (!source?.siteUrl) return;
    const sibling = await this.#recentSibling(feedSourceId, source.siteUrl);
    let icon: Blob | null;
    if (!sibling) icon = await this.#download(feedSourceId, source.siteUrl);
    else icon = sibling.faviconKey ? await this.#blobs.get(sibling.faviconKey) : null;
    if (icon) await this.#blobs.put(faviconKey(feedSourceId), icon);
    await this.#db
      .update(feedSources)
      .set({ faviconCheckedAt: sql`now()`, ...(icon && { faviconKey: faviconKey(feedSourceId) }) })
      .where(eq(feedSources.id, feedSourceId));
  }

  /** Another source of the same site whose icon was checked recently. */
  async #recentSibling(feedSourceId: number, siteUrl: string) {
    const origin = new URL(siteUrl).origin;
    const [row] = await this.#db
      .select({ faviconKey: feedSources.faviconKey })
      .from(feedSources)
      .where(
        sql`${feedSources.id} <> ${feedSourceId}
          AND (${feedSources.siteUrl} = ${origin} OR ${feedSources.siteUrl} LIKE ${`${origin}/%`})
          AND ${feedSources.faviconCheckedAt} > now() - make_interval(days => ${REUSE_DAYS})`,
      )
      .orderBy(sql`${feedSources.faviconKey} IS NULL`)
      .limit(1);
    return row;
  }

  #fetch(url: string, request: FetchRequest): Promise<FetchResult> {
    return this.#hosts.run(new URL(url).host, () =>
      this.#fetcher.fetch(url, { ...request, purpose: 'favicon' }),
    );
  }

  async #download(feedSourceId: number, siteUrl: string): Promise<Blob | null> {
    let candidates = [new URL('/favicon.ico', siteUrl).href];
    try {
      const page = await this.#fetch(siteUrl, {
        accept: 'text/html',
        maxBytes: MAX_PAGE_BYTES,
        truncate: true,
      });
      candidates = iconCandidates(decodeBody(page.body, page.contentType), page.url);
    } catch (err) {
      this.#logger.debug({ err, feedSourceId }, 'Favicon page fetch failed');
    }

    for (const url of candidates.slice(0, MAX_CANDIDATES)) {
      try {
        const response = await this.#fetch(url, { accept: 'image/*', maxBytes: MAX_ICON_BYTES });
        const contentType = imageContentType(response.body, response.contentType);
        if (
          contentType &&
          response.body.byteLength > 0 &&
          response.body.byteLength <= MAX_ICON_BYTES
        ) {
          return { data: response.body, contentType };
        }
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  /** The icon of a feed the user subscribes to; other feeds are not disclosed. */
  async getForUser(userId: number, feedSourceId: number): Promise<Blob | null> {
    const [subscribed] = await this.#db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedSourceId, feedSourceId)))
      .limit(1);
    return subscribed ? this.get(feedSourceId) : null;
  }

  async get(feedSourceId: number): Promise<Blob | null> {
    const [source] = await this.#db
      .select({ key: feedSources.faviconKey })
      .from(feedSources)
      .where(eq(feedSources.id, feedSourceId));
    return source?.key ? this.#blobs.get(source.key) : null;
  }
}

/**
 * Per-user path segments for icon URLs given to compatibility clients, which fetch icons without
 * credentials: only the holder of a user's segment can read that user's feeds' icons.
 */
export class IconTokens {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    this.#key = key;
  }

  issue(userId: number): string {
    return `${String(userId)}.${sign(this.#key, `icons:${String(userId)}`)}`;
  }

  /** The user a segment was issued to, or null when it is not one. */
  userOf(token: string): number | null {
    const [id = '', mac = ''] = token.split('.');
    if (!/^\d+$/.test(id) || !verify(this.#key, `icons:${id}`, mac)) return null;
    return Number(id);
  }
}
