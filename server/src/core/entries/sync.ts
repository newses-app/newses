import type { Entry } from '@newses/shared';
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { categories, feedSources, labels, subscriptions, tombstones } from '../../db/schema.ts';
import type { CategoryRow } from '../categories.ts';
import { DomainError } from '../errors.ts';
import type { SubscriptionView } from '../feeds/subscriptions.ts';
import { HEADLINE_FROM, type HeadlineRow, headlineColumns, toEntry } from './entries.ts';
import type { LabelRow } from './labels.ts';

/** Deletions are remembered this long; older sync tokens must resync from scratch. */
export const TOMBSTONE_RETENTION_DAYS = 30;

const tokenSchema = z.object({ t: z.string().max(64), i: z.number().int().min(0) });
type Token = z.infer<typeof tokenSchema>;

const encodeToken = (token: Token) => Buffer.from(JSON.stringify(token)).toString('base64url');

function decodeToken(value: string): Token {
  try {
    return tokenSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new DomainError('invalid_input', 'Invalid sync token');
  }
}

export interface SyncResult {
  categories: CategoryRow[];
  subscriptions: SubscriptionView[];
  labels: LabelRow[];
  entries: Entry[];
  deleted: { categories: number[]; subscriptions: number[]; labels: number[]; entries: number[] };
  next: string;
  more: boolean;
}

/**
 * Incremental sync over `updated_at` and tombstones.
 *
 * `updated_at` is the writing transaction's start time, so a row can become visible after rows
 * with later timestamps. Each call therefore only returns changes before a watermark: the start
 * of the oldest transaction still open in the database (or now). Everything before it has
 * committed, so the window [token, watermark) is complete and stable.
 */
export class SyncService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async changes(userId: number, since: string | undefined, limit: number): Promise<SyncResult> {
    const token = since ? decodeToken(since) : null;
    const [state] = (
      await this.#db.execute<{ watermark: string; expired: boolean }>(sql`
        SELECT least(now(), (
            SELECT min(xact_start) FROM pg_stat_activity
            WHERE datname = current_database() AND backend_type = 'client backend'
              AND pid <> pg_backend_pid()
          ))::text AS watermark,
          ${token ? sql`${token.t}::timestamptz < now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})` : sql`false`} AS expired`)
    ).rows;
    if (!state) throw new Error('Sync watermark query returned no row');
    if (state.expired)
      throw new DomainError('resync_required', 'Sync token expired; sync from scratch');
    const from = token?.t ?? '-infinity';
    const fromId = token?.i ?? 0;
    const to = state.watermark;

    const [entryRows, categoryRows, subscriptionRows, labelRows, deletedRows] = await Promise.all([
      this.#db.execute<HeadlineRow & { u: string }>(sql`
        SELECT ${headlineColumns(false)}, ue.updated_at::text AS u FROM ${HEADLINE_FROM}
        WHERE ue.user_id = ${userId}
          AND (ue.updated_at, ue.id) > (${from}::timestamptz, ${fromId})
          AND ue.updated_at < ${to}::timestamptz
        ORDER BY ue.updated_at, ue.id
        LIMIT ${limit + 1}`),
      this.#db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.userId, userId),
            gte(categories.updatedAt, sql`${from}::timestamptz`),
            lt(categories.updatedAt, sql`${to}::timestamptz`),
          ),
        ),
      // A subscription also changes when its feed's title, icon, or error state does.
      this.#db
        .select({ subscription: subscriptions, source: feedSources })
        .from(subscriptions)
        .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
        .where(
          and(
            eq(subscriptions.userId, userId),
            or(
              and(
                gte(subscriptions.updatedAt, sql`${from}::timestamptz`),
                lt(subscriptions.updatedAt, sql`${to}::timestamptz`),
              ),
              and(
                gte(feedSources.updatedAt, sql`${from}::timestamptz`),
                lt(feedSources.updatedAt, sql`${to}::timestamptz`),
              ),
            ),
          ),
        ),
      this.#db
        .select()
        .from(labels)
        .where(
          and(
            eq(labels.userId, userId),
            gte(labels.updatedAt, sql`${from}::timestamptz`),
            lt(labels.updatedAt, sql`${to}::timestamptz`),
          ),
        ),
      token
        ? this.#db
            .select({ entity: tombstones.entity, id: tombstones.entityId })
            .from(tombstones)
            .where(
              and(
                eq(tombstones.userId, userId),
                gte(tombstones.deletedAt, sql`${from}::timestamptz`),
                lt(tombstones.deletedAt, sql`${to}::timestamptz`),
              ),
            )
        : Promise.resolve([]),
    ]);

    const more = entryRows.rows.length > limit;
    const page = entryRows.rows.slice(0, limit);
    const last = page.at(-1);
    const next: Token = more && last ? { t: last.u, i: Number(last.id) } : { t: to, i: 0 };
    const deleted = {
      categories: [] as number[],
      subscriptions: [] as number[],
      labels: [] as number[],
      entries: [] as number[],
    };
    for (const { entity, id } of deletedRows) {
      if (entity === 'category') deleted.categories.push(id);
      else if (entity === 'subscription') deleted.subscriptions.push(id);
      else if (entity === 'label') deleted.labels.push(id);
      else if (entity === 'entry') deleted.entries.push(id);
    }
    return {
      categories: categoryRows,
      subscriptions: subscriptionRows,
      labels: labelRows,
      entries: page.map(toEntry),
      deleted,
      next: encodeToken(next),
      more,
    };
  }

  /** Forgets deletions older than the retention period. */
  async pruneTombstones(): Promise<number> {
    const result = await this.#db.execute(sql`
      DELETE FROM tombstones WHERE deleted_at < now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})`);
    return result.rowCount ?? 0;
  }
}
