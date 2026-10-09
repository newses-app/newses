import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '../../core/errors.ts';
import { normalizeFeedUrl } from '../../core/feeds/url.ts';
import { subscriptions } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import type { Writer } from '../import-map.ts';
import { CATEGORIES } from './categories.ts';
import { importedUsers } from './common.ts';

export const FEEDS = 'ttrss_feeds';
/** New sources' first fetches are spread over this window, so dispatch takes them gradually. */
const FIRST_FETCH_SPREAD_MINUTES = 30;
/** Per-feed update intervals allowed here, in minutes. */
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 10_080;
const MAX_PURGE_DAYS = 3650;

interface SourceFeedRow {
  id: number;
  title: string;
  cat_id: number | null;
  feed_url: string;
  site_url: string;
  update_interval: number;
  purge_interval: number;
  order_id: number;
  auth_login: string;
  [option: string]: unknown;
}

/** TTRSS per-feed options with no equivalent here, and the value that means "changed". */
const OPTIONS: [column: string, changed: boolean][] = [
  ['hidden', true],
  ['cache_images', true],
  ['hide_images', true],
  ['always_display_enclosures', true],
  ['mark_unread_on_update', true],
  ['update_on_checksum_change', true],
  ['strip_images', true],
  ['rtl_content', true],
  ['cache_content', true],
  ['private', true],
  ['include_in_digest', false],
];

/** The feed source for `url`, created with a first fetch within the spread window if new. */
async function sourceFor(tx: Writer, url: string, title: string, siteUrl: string | null) {
  const result = await tx.execute<{ id: number }>(sql`
    INSERT INTO feed_sources (url, title, site_url, next_fetch_at)
    VALUES (${url}, ${title}, ${siteUrl},
      now() + make_interval(secs => random() * ${FIRST_FETCH_SPREAD_MINUTES * 60}))
    ON CONFLICT (url) DO UPDATE SET
      title = coalesce(feed_sources.title, excluded.title),
      site_url = coalesce(feed_sources.site_url, excluded.site_url)
    RETURNING id`);
  const row = result.rows[0];
  if (!row) throw new Error('Feed source upsert returned no row');
  return row;
}

/**
 * Feeds: one shared feed source per normalised URL and a subscription per user with the feed's
 * title, category, order, and interval and purge overrides. Feeds with HTTP authentication are
 * skipped; per-feed options with no equivalent are noted.
 */
export const feedsStep: ImportStep = {
  name: 'feeds',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const login = user.login;
      // Subscriptions this run has imported for the user, by the TTRSS feed that became each.
      const taken = new Map<number, number>();
      for await (const rows of source.batches<SourceFeedRow>(
        (after, limit) => `SELECT * FROM ttrss_feeds WHERE owner_uid = $1 AND id > ${after}
          ORDER BY id LIMIT ${limit}`,
        [user.id],
      )) {
        report.count(login, 'feeds', { source: rows.length });
        const [mapped, categories] = await Promise.all([
          map.targets(
            FEEDS,
            rows.map((r) => r.id),
          ),
          map.targets(
            CATEGORIES,
            rows.flatMap((r) => (r.cat_id === null ? [] : [r.cat_id])),
          ),
        ]);
        await write(async (tx) => {
          for (const row of rows) {
            if (row.auth_login) {
              report.skip(login, 'feeds', row.id, 'HTTP authentication is not supported yet');
              continue;
            }
            let url: string;
            try {
              url = normalizeFeedUrl(row.feed_url);
            } catch (err) {
              if (!(err instanceof DomainError)) throw err;
              report.skip(login, 'feeds', row.id, err.message);
              continue;
            }
            const feedSource = await sourceFor(tx, url, row.title, row.site_url || null);
            const [existing] = await tx
              .select({ id: subscriptions.id })
              .from(subscriptions)
              .where(
                and(
                  eq(subscriptions.userId, userId),
                  eq(subscriptions.feedSourceId, feedSource.id),
                ),
              );
            const duplicateOf = [...taken].find(([, id]) => id === existing?.id)?.[0];
            if (duplicateOf !== undefined) {
              report.skip(login, 'feeds', row.id, `same feed as ${String(duplicateOf)}`);
              continue;
            }
            const values = {
              // The title the user saw in TTRSS, kept when the feed's own title changes.
              title: row.title,
              categoryId: row.cat_id === null ? null : (categories.get(row.cat_id) ?? null),
              sortOrder: row.order_id,
              updateIntervalSeconds: updateInterval(row, (text) => {
                report.note(login, 'feeds', row.id, text);
              }),
              purgeDays: purgeDays(row, (text) => {
                report.note(login, 'feeds', row.id, text);
              }),
            };
            // The user's subscription to this source, else the one imported before (its URL changed).
            let targetId = existing?.id ?? mapped.get(row.id);
            if (targetId !== undefined) {
              const [updated] = await tx
                .update(subscriptions)
                .set({ feedSourceId: feedSource.id, ...values })
                .where(and(eq(subscriptions.id, targetId), eq(subscriptions.userId, userId)))
                .returning({ id: subscriptions.id });
              targetId = updated?.id;
            }
            if (targetId === undefined) {
              const [created] = await tx
                .insert(subscriptions)
                .values({ userId, feedSourceId: feedSource.id, ...values })
                .returning({ id: subscriptions.id });
              if (!created) throw new Error('Subscription insert returned no row');
              targetId = created.id;
            }
            taken.set(row.id, targetId);
            await map.record(tx, FEEDS, [{ sourceId: row.id, targetId, userId }]);
            const options = OPTIONS.filter(([column, changed]) => row[column] === changed).map(
              ([column, changed]) => (changed ? column : `${column} off`),
            );
            if (options.length > 0)
              report.note(login, 'feeds', row.id, `options not imported: ${options.join(', ')}`);
            report.count(login, 'feeds', { imported: 1 });
          }
        });
      }
    }
  },
};

/** TTRSS `update_interval` (minutes; 0 is the default, -1 disables updates) in seconds. */
function updateInterval(row: SourceFeedRow, note: (text: string) => void): number | null {
  const minutes = row.update_interval;
  if (minutes === 0) return null;
  if (minutes < 0) {
    note('updates were disabled in TTRSS; the feed is fetched here');
    return null;
  }
  const allowed = Math.min(Math.max(minutes, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
  if (allowed !== minutes)
    note(`update interval ${String(minutes)} min changed to ${String(allowed)} min`);
  return allowed * 60;
}

/** TTRSS `purge_interval` (days; 0 is the default, -1 never purges) as `purge_days`. */
function purgeDays(row: SourceFeedRow, note: (text: string) => void): number | null {
  const days = row.purge_interval;
  if (days === 0) return null;
  if (days === -1) return 0;
  if (days < 0) {
    note(`purge interval ${String(days)} not imported`);
    return null;
  }
  return Math.min(days, MAX_PURGE_DAYS);
}
