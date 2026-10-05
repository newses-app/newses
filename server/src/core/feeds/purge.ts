import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { FeedSettings } from '../config.ts';
import type { BlobStore } from '../ports.ts';
import { faviconKey } from './favicons.ts';
import { purgeDaysSql } from './ingest.ts';

/** Unreferenced entries are deleted only after they have been absent from their feed this long. */
const ORPHAN_GRACE_DAYS = 7;

export interface PurgeResult {
  userEntries: number;
  entries: number;
  feedSources: number;
}

export class Purger {
  readonly #db: Db;
  readonly #blobs: BlobStore;
  readonly #settings: FeedSettings;

  constructor(db: Db, blobs: BlobStore, settings: FeedSettings) {
    this.#db = db;
    this.#blobs = blobs;
    this.#settings = settings;
  }

  /**
   * Deletes user entries older than their subscription's purge age (never starred or published
   * ones), then entries nobody references that have left their feed, then feed sources with no
   * subscribers and no kept entries. Also forgets expired host cooldowns.
   */
  async purge(): Promise<PurgeResult> {
    const userEntries = await this.#db.execute(sql`
      DELETE FROM user_entries ue
      USING subscriptions s CROSS JOIN LATERAL (SELECT ${purgeDaysSql(this.#settings.purgeDays)} AS days) purge
      WHERE ue.subscription_id = s.id
        AND NOT ue.starred AND NOT ue.published
        AND purge.days > 0
        AND ue.sort_at < now() - make_interval(days => purge.days)`);

    const entries = await this.#db.execute(sql`
      DELETE FROM entries e
      WHERE e.last_seen_at < now() - make_interval(days => ${ORPHAN_GRACE_DAYS})
        AND NOT EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id)`);

    const sources = await this.#db.execute<{ id: number }>(sql`
      DELETE FROM feed_sources fs
      WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_source_id = fs.id)
        AND NOT EXISTS (
          SELECT 1 FROM entries e JOIN user_entries ue ON ue.entry_id = e.id WHERE e.feed_source_id = fs.id
        )
      RETURNING fs.id`);
    await Promise.all(sources.rows.map(({ id }) => this.#blobs.delete(faviconKey(id))));
    await this.#db.execute(sql`DELETE FROM fetch_hosts WHERE blocked_until < now()`);

    return {
      userEntries: userEntries.rowCount ?? 0,
      entries: entries.rowCount ?? 0,
      feedSources: sources.rows.length,
    };
  }
}
