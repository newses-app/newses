import { createHash } from 'node:crypto';
import { type Enclosure, enclosureKind } from '@newses/shared';
import { eq, sql } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import type { Db } from '../../db/client.ts';
import { entryImages, entryImageSets, imageCache } from '../../db/schema.ts';
import { CONTENT_VERSION } from '../entries/entries.ts';
import { sign, verify } from '../crypto.ts';
import type { Blob, BlobStore, Logger } from '../ports.ts';
import { imageContentType } from './image-type.ts';
import { KEPT_ENTRY, KEPT_ENTRY_IDS } from './purge.ts';
import { mapSrcset } from './srcset.ts';
import { type Fetcher, FetchError } from './http.ts';
import { httpUrl } from './url.ts';

export const IMAGE_PATH = '/api/v1/images';
/** Lambda responses are capped at 6 MB after base64, so images stay under 4 MB. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A failed image is not requested again from its host for this long. */
const FAILURE_RETRY_HOURS = 24;
/** Cached images and failures are deleted by the purge after this many days, except kept ones. */
export const IMAGE_CACHE_DAYS = 30;
/** A kept entry's image that keeps failing is not asked for again after this many tries. */
const KEPT_ATTEMPTS = 3;
/** Kept entries listed, and kept images fetched, per query of the sweep. */
const KEEP_INDEX_BATCH = 200;
const KEEP_FETCH_BATCH = 50;
/** Kept images fetched at once, across hosts; the per-host limits still apply. */
const KEEP_CONCURRENCY = 4;

export const imageKey = (url: string) => `images/${createHash('sha256').update(url).digest('hex')}`;

export type ImageResult = { image: Blob } | { error: 'forbidden' | 'unavailable' };

/** An image as it appears in entry HTML, and its proxy path. */
export interface ImageSource {
  url: string;
  proxy: string;
}

/** Images listed per entry for clients that store them. */
const MAX_SOURCES = 30;

/** Maps the image URLs in sanitised entry HTML: `img` src and srcset, picture sources, video posters. */
function mapImages(html: string, map: (url: string) => string): string {
  const srcset = (value: string) => mapSrcset(value, map);
  return sanitizeHtml(html, {
    // The content was sanitised at ingest; this pass only maps image URLs.
    allowedTags: false,
    allowedAttributes: false,
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      img: (tagName, attribs) => {
        if (attribs.src) attribs.src = map(attribs.src);
        if (attribs.srcset) attribs.srcset = srcset(attribs.srcset);
        return { tagName, attribs };
      },
      // Picture sources carry images in srcset; media sources use src and are left alone.
      source: (tagName, attribs) => {
        if (attribs.srcset) attribs.srcset = srcset(attribs.srcset);
        return { tagName, attribs };
      },
      video: (tagName, attribs) => {
        if (attribs.poster) attribs.poster = map(attribs.poster);
        return { tagName, attribs };
      },
    },
  });
}

/**
 * Serves entry images from this server, so feed hosts never see readers' addresses and pages
 * load no third-party requests. Only URLs this server signed are fetched.
 */
export class ImageProxy {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #blobs: BlobStore;
  readonly #key: Buffer;
  readonly #logger: Logger;

  constructor(deps: {
    db: Db;
    /** Polite: within the per-host limits and host pauses. */
    fetcher: Fetcher;
    blobs: BlobStore;
    key: Buffer;
    logger: Logger;
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#blobs = deps.blobs;
    this.#key = deps.key;
    this.#logger = deps.logger;
  }

  /**
   * The proxy path for an image URL, after `origin` when given (for documents read elsewhere,
   * such as feeds); other values (data: URLs, garbage) are returned as is.
   */
  path(url: string, origin = ''): string {
    const absolute = httpUrl(url);
    if (!absolute) return url;
    const encoded = Buffer.from(absolute).toString('base64url');
    return `${origin}${IMAGE_PATH}/${sign(this.#key, absolute)}/${encoded}`;
  }

  /** Points image sources in sanitised entry HTML at the proxy, after `origin` when given. */
  rewrite(html: string, origin = ''): string {
    return mapImages(html, (url) => this.path(url, origin));
  }

  /**
   * The http(s) images in sanitised entry HTML, each with its proxy path, in document order, then
   * the entry's image enclosures, at most `limit`; for clients that store articles' images.
   */
  sources(html: string, enclosures: readonly Enclosure[] = [], limit = MAX_SOURCES): ImageSource[] {
    const urls = new Set<string>();
    const add = (url: string) => {
      if (urls.size < limit && httpUrl(url)) urls.add(url);
      return url;
    };
    mapImages(html, add);
    for (const enclosure of enclosures)
      if (enclosureKind(enclosure) === 'image') add(enclosure.url);
    return [...urls].map((url) => ({ url, proxy: this.path(url) }));
  }

  /** The image for a signed path, from the cache or fetched politely from its host. */
  async get(signature: string, encoded: string): Promise<ImageResult> {
    const url = httpUrl(Buffer.from(encoded, 'base64url').toString());
    if (!url || !verify(this.#key, url, signature)) return { error: 'forbidden' };
    const key = imageKey(url);

    const [cached] = await this.#db
      .select({
        failed: imageCache.failed,
        retry: sql<boolean>`${imageCache.fetchedAt} < now() - make_interval(hours => ${FAILURE_RETRY_HOURS})`,
      })
      .from(imageCache)
      .where(eq(imageCache.key, key));
    if (cached && !cached.failed) {
      const image = await this.#blobs.get(key);
      if (image) return { image };
    }
    if (cached?.failed && !cached.retry) return { error: 'unavailable' };

    const image = await this.#fetch(key, url);
    return image && image !== 'blocked' ? { image } : { error: 'unavailable' };
  }

  /**
   * Fetches an image into the cache, remembering a failure; `blocked` while its host is paused,
   * which is asked again once the pause ends, not after the failure delay.
   */
  async #fetch(key: string, url: string): Promise<Blob | null | 'blocked'> {
    let image: Blob | null = null;
    try {
      const response = await this.#fetcher.fetch(url, {
        purpose: 'image',
        accept: 'image/*',
        maxBytes: MAX_IMAGE_BYTES,
      });
      const contentType = imageContentType(response.body, response.contentType);
      if (contentType && response.body.byteLength > 0) {
        image = { data: response.body, contentType };
      }
    } catch (err) {
      if (err instanceof FetchError && err.code === 'host_blocked') return 'blocked';
      this.#logger.debug({ err, url }, 'Image fetch failed');
    }
    if (image) await this.#blobs.put(key, image);
    const size = image?.data.byteLength ?? 0;
    await this.#db
      .insert(imageCache)
      .values({ key, size, failed: !image, attempts: image ? 0 : 1 })
      .onConflictDoUpdate({
        target: imageCache.key,
        set: {
          fetchedAt: sql`now()`,
          size,
          failed: !image,
          attempts: image ? 0 : sql`${imageCache.attempts} + 1`,
        },
      });
    return image;
  }

  /**
   * Keeps the images of kept entries (starred, published, noted, labelled, or shared): lists each
   * one's images as offline clients get them, again when its content changes, then fetches those
   * not cached yet, and failures again after a day, up to KEPT_ATTEMPTS times. Stops once
   * `budgetMs` has passed; the rest waits for the next run.
   */
  async keep(budgetMs: number): Promise<{ indexed: number; fetched: number }> {
    const deadline = Date.now() + budgetMs;
    let indexed = 0;
    while (Date.now() < deadline) {
      const { rows } = await this.#db.execute<{
        id: string;
        html: string;
        version: string;
      }>(sql`
        SELECT e.id, coalesce(e.content, '') || coalesce(e.full_content, '') AS html,
          ${CONTENT_VERSION} AS version
        FROM entries e
        WHERE e.id IN ${KEPT_ENTRY_IDS}
          AND NOT EXISTS (SELECT 1 FROM entry_image_sets s
            WHERE s.entry_id = e.id AND s.version = ${CONTENT_VERSION})
        LIMIT ${KEEP_INDEX_BATCH}`);
      if (rows.length === 0) break;
      for (const { id, html, version } of rows) await this.#index(Number(id), html, version);
      indexed += rows.length;
    }

    let fetched = 0;
    while (Date.now() < deadline) {
      const { rows } = await this.#db.execute<{ key: string; url: string }>(sql`
        SELECT DISTINCT ON (ei.key) ei.key, ei.url FROM entry_images ei
        LEFT JOIN image_cache c ON c.key = ei.key
        WHERE c.key IS NULL OR (c.failed AND c.attempts < ${KEPT_ATTEMPTS}
          AND c.fetched_at < now() - make_interval(hours => ${FAILURE_RETRY_HOURS}))
        ORDER BY ei.key
        LIMIT ${KEEP_FETCH_BATCH}`);
      if (rows.length === 0) break;
      const queue = [...rows];
      const counts = await Promise.all(
        Array.from({ length: KEEP_CONCURRENCY }, async () => {
          let count = 0;
          for (let next = queue.shift(); next && Date.now() < deadline; next = queue.shift())
            if ((await this.#fetch(next.key, next.url)) !== 'blocked') count += 1;
          return count;
        }),
      );
      const done = counts.reduce((sum, count) => sum + count, 0);
      fetched += done;
      // Only paused hosts are left: they wait for the next run.
      if (done === 0) break;
    }
    return { indexed, fetched };
  }

  /** Replaces the entry's listed images with those of its content version. */
  async #index(entryId: number, html: string, version: string): Promise<void> {
    const images = this.sources(html).map(({ url }) => ({ entryId, key: imageKey(url), url }));
    await this.#db.transaction(async (tx) => {
      await tx.delete(entryImages).where(eq(entryImages.entryId, entryId));
      if (images.length > 0) await tx.insert(entryImages).values(images).onConflictDoNothing();
      await tx
        .insert(entryImageSets)
        .values({ entryId, version })
        .onConflictDoUpdate({ target: entryImageSets.entryId, set: { version } });
    });
  }

  /**
   * Forgets the images of entries no longer kept, then deletes cache entries and their blobs
   * older than IMAGE_CACHE_DAYS, except images of kept entries; returns how many.
   */
  async purge(): Promise<number> {
    const unkept = sql`NOT EXISTS (SELECT 1 FROM user_entries ue
      WHERE ue.entry_id = t.entry_id AND ${KEPT_ENTRY})`;
    await this.#db.execute(sql`DELETE FROM entry_images t WHERE ${unkept}`);
    await this.#db.execute(sql`DELETE FROM entry_image_sets t WHERE ${unkept}`);
    const expired = await this.#db
      .delete(imageCache)
      .where(
        sql`${imageCache.fetchedAt} < now() - make_interval(days => ${IMAGE_CACHE_DAYS})
          AND (${imageCache.failed}
            OR NOT EXISTS (SELECT 1 FROM entry_images ei WHERE ei.key = ${imageCache.key}))`,
      )
      .returning({ key: imageCache.key, failed: imageCache.failed });
    await Promise.all(expired.filter((e) => !e.failed).map((e) => this.#blobs.delete(e.key)));
    return expired.length;
  }
}
