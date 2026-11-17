import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { plainText } from '../entries/text.ts';
import { PAGES_SOURCE_URL } from '../feeds/pages.ts';
import type { PluginEntry } from './catalog.ts';

/** Characters of article text a hook gets. */
export const MAX_TEXT = 20_000;

interface EntryRow extends Record<string, unknown> {
  id: string;
  title: string | null;
  link: string | null;
  author: string | null;
  at: string;
  published: boolean;
  unread: boolean;
  content: string | null;
  content_hash: string;
  subscription_id: number | null;
  feed_title: string | null;
  feed_url: string | null;
  with_login: boolean | null;
}

/**
 * The user's entries among `ids`, as hooks see them, in the order of `ids`; with `text`, each
 * with its plain text (full text when extracted). An entry's feed is the user's subscription and
 * title; a feed with a login has no URL, and pages have no feed.
 */
export async function readPluginEntries(
  db: Pick<Db, 'execute'>,
  userId: number,
  ids: readonly number[],
  { text }: { text: boolean },
): Promise<{ entry: PluginEntry; contentHash: string; text: string | null }[]> {
  if (ids.length === 0) return [];
  const rows = await db.execute<EntryRow>(sql`
    SELECT ue.id, e.title, e.link, e.author,
      coalesce(e.published_at, e.fetched_at)::text AS at, ue.published, ue.unread,
      ${text ? sql`coalesce(e.full_content, e.content)` : sql`NULL`} AS content,
      e.content_hash, s.id AS subscription_id,
      coalesce(s.title, fs.title, fs.url) AS feed_title, fs.url AS feed_url,
      fs.auth_login IS NOT NULL AS with_login
    FROM user_entries ue
    JOIN entries e ON e.id = ue.entry_id
    LEFT JOIN subscriptions s ON s.id = ue.subscription_id
    LEFT JOIN feed_sources fs ON fs.id = e.feed_source_id AND fs.url <> ${PAGES_SOURCE_URL}
    WHERE ue.user_id = ${userId} AND ue.id = ANY(${sql.param([...ids])}::bigint[])`);
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.rows
    .map((row) => ({
      entry: {
        id: Number(row.id),
        title: row.title ?? '',
        link: row.link,
        author: row.author,
        publishedAt: new Date(row.at).toISOString(),
        published: row.published,
        unread: row.unread,
        feed:
          row.subscription_id !== null && row.feed_title !== null
            ? {
                id: row.subscription_id,
                title: row.feed_title,
                url: row.with_login ? null : row.feed_url,
                withLogin: row.with_login === true,
              }
            : null,
      },
      contentHash: row.content_hash,
      text: text ? (plainText(row.content) ?? '').slice(0, MAX_TEXT) : null,
    }))
    .sort((a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0));
}
