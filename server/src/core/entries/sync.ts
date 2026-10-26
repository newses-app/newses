import { randomUUID } from 'node:crypto';
import type { Entry } from '@newses/shared';
import { type AnyColumn, and, eq, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import {
  categories,
  feedSources,
  labels,
  opsState,
  subscriptions,
  tombstones,
} from '../../db/schema.ts';
import type { CategoryRow } from '../categories.ts';
import { DomainError } from '../errors.ts';
import type { SubscriptionView } from '../feeds/subscriptions.ts';
import { HEADLINE_FROM, type HeadlineRow, headlineColumns, toEntry } from './entries.ts';
import type { LabelRow } from './labels.ts';

/** Deletions are remembered this long; older sync tokens must resync from scratch. */
export const TOMBSTONE_RETENTION_DAYS = 30;
const RETENTION_SECONDS = TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60;

/** `ops_state` key of the instance's sync epoch, made afresh when a restore leaves it out. */
const EPOCH_KEY = 'sync_epoch';

/**
 * A place in the change stream: after (`x`, `i`), a row's sync_xid and id. `t` is when the stream
 * reached it, for expiry, and `e` the epoch it belongs to. While a full sync pages, `f` is the
 * watermark its changes carry on from.
 */
const tokenSchema = z.object({
  e: z.string().max(64),
  x: z.number().int().min(0),
  i: z.number().int().min(0),
  t: z.number().int(),
  f: z.number().int().min(0).optional(),
});
type Token = z.infer<typeof tokenSchema>;

/** A token from before sync_xid: a place by (updated_at, id) among the rows written before it. */
const legacyTokenSchema = z.object({
  t: z
    .string()
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}[ T][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/),
  i: z.number().int().min(0),
});
type LegacyToken = z.infer<typeof legacyTokenSchema>;

type Cursor =
  { kind: 'full' } | { kind: 'xid'; token: Token } | { kind: 'legacy'; token: LegacyToken };

const encode = (token: Token | LegacyToken) =>
  Buffer.from(JSON.stringify(token)).toString('base64url');

const resync = (message: string) => new DomainError('resync_required', message);

/** Anything but a current or legacy token asks for a resync, which every client handles. */
function decodeToken(value: string | undefined): Cursor {
  if (!value) return { kind: 'full' };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch {
    throw resync('Unknown sync token; sync from scratch');
  }
  const token = tokenSchema.safeParse(json);
  if (token.success) return { kind: 'xid', token: token.data };
  const legacy = legacyTokenSchema.safeParse(json);
  if (legacy.success) return { kind: 'legacy', token: legacy.data };
  throw resync('Unknown sync token; sync from scratch');
}

const xid = (value: number) => sql`${String(value)}::xid8`;

export interface SyncResult {
  categories: CategoryRow[];
  subscriptions: SubscriptionView[];
  labels: LabelRow[];
  entries: Entry[];
  deleted: { categories: number[]; subscriptions: number[]; labels: number[]; entries: number[] };
  next: string;
  more: boolean;
}

interface SyncState {
  /** sync_watermark(): every transaction of the database below it has ended. */
  watermark: number;
  /** The database's clock, in epoch seconds. */
  now: number;
  epoch: string;
  /** A legacy token's time, in epoch seconds. */
  legacyAt: number | null;
}

/**
 * Incremental sync over sync_xid, the id of the transaction that last wrote a row, and tombstones.
 *
 * A row's sync_xid can commit after rows with higher ones, so each call only returns changes below
 * a watermark: the oldest transaction id still in progress in the database. Everything below it
 * has ended, so the window [token, watermark) is complete and stable, whatever the clock does.
 * A full sync takes every row, with no upper bound, then carries on from the watermark it started
 * at; rows written meanwhile are at or above it, and come again as duplicates at worst.
 */
export class SyncService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** A token at the present, for clients that load current state some other way and then follow changes. */
  async token(): Promise<string> {
    const state = await this.#state(null);
    return encode({ e: state.epoch, x: state.watermark, i: 0, t: state.now });
  }

  async changes(userId: number, since: string | undefined, limit: number): Promise<SyncResult> {
    const cursor = decodeToken(since);
    const state = await this.#state(cursor.kind === 'legacy' ? cursor.token.t : null);
    if (cursor.kind === 'xid') {
      if (cursor.token.e !== state.epoch)
        throw resync('Sync token from another copy of this instance; sync from scratch');
      if (cursor.token.t < state.now - RETENTION_SECONDS)
        throw resync('Sync token expired; sync from scratch');
    }
    if (cursor.kind === 'legacy' && (state.legacyAt ?? 0) < state.now - RETENTION_SECONDS)
      throw resync('Sync token expired; sync from scratch');

    // Which rows of the other synced tables changed in this call's window; undefined for none.
    const changed = (xidColumn: AnyColumn, at: AnyColumn): SQL | undefined => {
      if (cursor.kind === 'full') return sql`true`;
      if (cursor.kind === 'legacy')
        return sql`${xidColumn} = '0' AND ${at} >= ${cursor.token.t}::timestamptz`;
      if (cursor.token.f !== undefined) return undefined;
      return sql`${xidColumn} >= ${xid(cursor.token.x)} AND ${xidColumn} < ${xid(state.watermark)}`;
    };
    const categoryWindow = changed(categories.syncXid, categories.updatedAt);
    const subscriptionWindow = changed(subscriptions.syncXid, subscriptions.updatedAt);
    const sourceWindow = changed(feedSources.syncXid, feedSources.updatedAt);
    const labelWindow = changed(labels.syncXid, labels.updatedAt);
    const deletedWindow =
      cursor.kind === 'full' ? undefined : changed(tombstones.syncXid, tombstones.deletedAt);

    const [entryRows, categoryRows, subscriptionRows, labelRows, deletedRows] = await Promise.all([
      this.#entries(userId, cursor, state.watermark, limit),
      categoryWindow
        ? this.#db
            .select()
            .from(categories)
            .where(and(eq(categories.userId, userId), categoryWindow))
        : Promise.resolve([]),
      // A subscription also changes when its feed's title, icon, or error state does.
      subscriptionWindow && sourceWindow
        ? this.#db
            .select({ subscription: subscriptions, source: feedSources })
            .from(subscriptions)
            .innerJoin(feedSources, eq(feedSources.id, subscriptions.feedSourceId))
            .where(and(eq(subscriptions.userId, userId), or(subscriptionWindow, sourceWindow)))
        : Promise.resolve([]),
      labelWindow
        ? this.#db
            .select()
            .from(labels)
            .where(and(eq(labels.userId, userId), labelWindow))
        : Promise.resolve([]),
      deletedWindow
        ? this.#db
            .select({ entity: tombstones.entity, id: tombstones.entityId })
            .from(tombstones)
            .where(and(eq(tombstones.userId, userId), deletedWindow))
        : Promise.resolve([]),
    ]);

    let more = entryRows.rows.length > limit;
    const page = entryRows.rows.slice(0, limit);
    const last = more ? page.at(-1) : undefined;
    let next: Token | LegacyToken;
    if (cursor.kind === 'legacy') {
      // Rows written since sync_xid came in follow at once, from its first transaction id.
      next = last
        ? { t: last.c, i: Number(last.id) }
        : { e: state.epoch, x: 1, i: 0, t: state.legacyAt ?? 0 };
      more = true;
    } else {
      const { epoch: e, watermark } = state;
      const after = last ? { x: Number(last.c), i: Number(last.id) } : undefined;
      if (cursor.kind === 'full')
        next = after
          ? { e, ...after, t: state.now, f: watermark }
          : { e, x: watermark, i: 0, t: state.now };
      else if (cursor.token.f !== undefined)
        next = after
          ? { e, ...after, t: cursor.token.t, f: cursor.token.f }
          : { e, x: cursor.token.f, i: 0, t: cursor.token.t };
      else
        next = after ? { e, ...after, t: cursor.token.t } : { e, x: watermark, i: 0, t: state.now };
    }

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
      next: encode(next),
      more,
    };
  }

  /** Forgets deletions older than the retention period. */
  async pruneTombstones(): Promise<number> {
    const result = await this.#db.execute(sql`
      DELETE FROM tombstones WHERE deleted_at < now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})`);
    return result.rowCount ?? 0;
  }

  /**
   * Up to `limit + 1` of the user's entries after the cursor, with `c`, the cursor column: sync_xid,
   * below the watermark except in a full sync, or updated_at among the rows from before sync_xid.
   */
  #entries(userId: number, cursor: Cursor, watermark: number, limit: number) {
    if (cursor.kind === 'legacy')
      return this.#db.execute<HeadlineRow & { c: string }>(sql`
        SELECT ${headlineColumns(false)}, ue.updated_at::text AS c FROM ${HEADLINE_FROM}
        WHERE ue.user_id = ${userId} AND ue.sync_xid = '0'
          AND (ue.updated_at, ue.id) > (${cursor.token.t}::timestamptz, ${cursor.token.i})
        ORDER BY ue.updated_at, ue.id
        LIMIT ${limit + 1}`);
    const from = cursor.kind === 'xid' ? cursor.token : { x: 0, i: 0, f: undefined };
    const below = cursor.kind === 'xid' && from.f === undefined;
    return this.#db.execute<HeadlineRow & { c: string }>(sql`
      SELECT ${headlineColumns(false)}, ue.sync_xid::text AS c FROM ${HEADLINE_FROM}
      WHERE ue.user_id = ${userId} AND (ue.sync_xid, ue.id) > (${xid(from.x)}, ${from.i})
        ${below ? sql`AND ue.sync_xid < ${xid(watermark)}` : sql``}
      ORDER BY ue.sync_xid, ue.id
      LIMIT ${limit + 1}`);
  }

  /** The watermark, the database's clock, and the epoch, which is made on first use. */
  async #state(legacyAt: string | null): Promise<SyncState> {
    const read = async () => {
      const [row] = (
        await this.#db.execute<{
          watermark: string;
          now: string;
          epoch: string | null;
          legacy_at: string | null;
        }>(sql`
          SELECT sync_watermark()::text AS watermark, extract(epoch FROM now())::bigint::text AS now,
            (SELECT value #>> '{}' FROM ops_state WHERE key = ${EPOCH_KEY}) AS epoch,
            ${legacyAt === null ? sql`NULL` : sql`extract(epoch FROM ${legacyAt}::timestamptz)::bigint::text`} AS legacy_at`)
      ).rows;
      if (!row) throw new Error('Sync watermark query returned no row');
      return row;
    };
    let row = await read();
    if (row.epoch === null) {
      await this.#db
        .insert(opsState)
        .values({ key: EPOCH_KEY, value: randomUUID().replaceAll('-', '') })
        .onConflictDoNothing();
      row = await read();
    }
    if (row.epoch === null) throw new Error('Sync epoch missing');
    return {
      watermark: Number(row.watermark),
      now: Number(row.now),
      epoch: row.epoch,
      legacyAt: row.legacy_at === null ? null : Number(row.legacy_at),
    };
  }
}
