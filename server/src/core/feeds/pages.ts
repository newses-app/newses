import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';

/**
 * Feed source of pages from outside any feed (published pages, imported kept articles that
 * belong to no feed). Not an http(s) URL, so nobody can subscribe to it; it is never fetched or
 * purged, and its entries are each one user's own.
 */
export const PAGES_SOURCE_URL = 'newses:pages';
export const PAGES_SOURCE_TITLE = 'Web pages';

/** GUID of a user's page in the pages source: one entry per user and normalised URL. */
export const pageGuid = (userId: number, url: string) =>
  `page:${createHash('sha256')
    .update(`${String(userId)}\n${url}`)
    .digest('hex')}`;

/** The pages source's id; the migration creates it, this recreates it if it went missing. */
export async function pagesSourceId(executor: Pick<Db, 'execute'>): Promise<number> {
  // A source created concurrently after this statement's snapshot shows on the second try.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executor.execute<{ id: number }>(sql`
      WITH created AS (
        INSERT INTO feed_sources (url, title, disabled_at)
        VALUES (${PAGES_SOURCE_URL}, ${PAGES_SOURCE_TITLE}, now())
        ON CONFLICT (url) DO NOTHING
        RETURNING id)
      SELECT id FROM created
      UNION ALL SELECT id FROM feed_sources WHERE url = ${PAGES_SOURCE_URL}
      LIMIT 1`);
    const id = result.rows[0]?.id;
    if (id !== undefined) return id;
  }
  throw new Error('Pages feed source missing');
}
