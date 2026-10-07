import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import type { Db } from '../../db/client.ts';
import { fetchHosts, imageCache } from '../../db/schema.ts';
import { sign, verify } from '../crypto.ts';
import type { Blob, BlobStore, Logger } from '../ports.ts';
import type { HostLimiter } from './host-limiter.ts';
import { imageContentType } from './image-type.ts';
import type { Fetcher } from './http.ts';
import { httpUrl } from './url.ts';

export const IMAGE_PATH = '/api/v1/images';
/** Lambda responses are capped at 6 MB after base64, so images stay under 4 MB. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A failed image is not requested again from its host for this long. */
const FAILURE_RETRY_HOURS = 24;
/** Cached images and failures are deleted by the purge after this many days. */
export const IMAGE_CACHE_DAYS = 30;

export const imageKey = (url: string) => `images/${createHash('sha256').update(url).digest('hex')}`;

export type ImageResult = { image: Blob } | { error: 'forbidden' | 'unavailable' };

/**
 * Serves entry images from this server, so feed hosts never see readers' addresses and pages
 * load no third-party requests. Only URLs this server signed are fetched.
 */
export class ImageProxy {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #blobs: BlobStore;
  readonly #hosts: HostLimiter;
  readonly #key: Buffer;
  readonly #logger: Logger;

  constructor(deps: {
    db: Db;
    fetcher: Fetcher;
    blobs: BlobStore;
    hosts: HostLimiter;
    key: Buffer;
    logger: Logger;
  }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#blobs = deps.blobs;
    this.#hosts = deps.hosts;
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
    const srcset = (value: string) =>
      value
        .split(',')
        .map((candidate) => {
          const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
          return [this.path(url, origin), ...descriptor].join(' ');
        })
        .join(', ');
    return sanitizeHtml(html, {
      // The content was sanitised at ingest; this pass only rewrites image URLs.
      allowedTags: false,
      allowedAttributes: false,
      allowedSchemesByTag: { img: ['http', 'https', 'data'] },
      transformTags: {
        img: (tagName, attribs) => {
          if (attribs.src) attribs.src = this.path(attribs.src, origin);
          if (attribs.srcset) attribs.srcset = srcset(attribs.srcset);
          return { tagName, attribs };
        },
        // Picture sources carry images in srcset; media sources use src and are left alone.
        source: (tagName, attribs) => {
          if (attribs.srcset) attribs.srcset = srcset(attribs.srcset);
          return { tagName, attribs };
        },
        video: (tagName, attribs) => {
          if (attribs.poster) attribs.poster = this.path(attribs.poster, origin);
          return { tagName, attribs };
        },
      },
    });
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

    const host = new URL(url).host;
    const [paused] = await this.#db
      .select({ host: fetchHosts.host })
      .from(fetchHosts)
      .where(and(eq(fetchHosts.host, host), sql`${fetchHosts.blockedUntil} > now()`));
    if (paused) return { error: 'unavailable' };

    let image: Blob | null = null;
    try {
      const response = await this.#hosts.run(host, () =>
        this.#fetcher.fetch(url, { accept: 'image/*', maxBytes: MAX_IMAGE_BYTES }),
      );
      const contentType = imageContentType(response.body, response.contentType);
      if (contentType && response.body.byteLength > 0) {
        image = { data: response.body, contentType };
      }
    } catch (err) {
      this.#logger.debug({ err, url }, 'Image fetch failed');
    }
    if (image) await this.#blobs.put(key, image);
    await this.#db
      .insert(imageCache)
      .values({ key, size: image?.data.byteLength ?? 0, failed: !image })
      .onConflictDoUpdate({
        target: imageCache.key,
        set: { fetchedAt: sql`now()`, size: image?.data.byteLength ?? 0, failed: !image },
      });
    return image ? { image } : { error: 'unavailable' };
  }

  /** Deletes cache entries and their blobs older than IMAGE_CACHE_DAYS; returns how many. */
  async purge(): Promise<number> {
    const expired = await this.#db
      .delete(imageCache)
      .where(sql`${imageCache.fetchedAt} < now() - make_interval(days => ${IMAGE_CACHE_DAYS})`)
      .returning({ key: imageCache.key, failed: imageCache.failed });
    await Promise.all(expired.filter((e) => !e.failed).map((e) => this.#blobs.delete(e.key)));
    return expired.length;
  }
}
