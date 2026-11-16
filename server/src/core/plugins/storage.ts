import { and, asc, eq, gt, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pluginStorage } from '../../db/schema.ts';

/** What one store holds at most: per key, per value (as JSON, in bytes), and in all. */
export const STORE_LIMITS = {
  keyLength: 200,
  valueBytes: 64 * 1024,
  keys: 10_000,
  bytes: 16 * 1024 * 1024,
} as const;

const MAX_TTL_SECONDS = 366 * 24 * 60 * 60;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/** A plugin's key-value store for the instance or one user; values are JSON. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(
    prefix?: string,
    options?: { after?: string; limit?: number },
  ): Promise<{ key: string; value: unknown }[]>;
}

const live = sql`(${pluginStorage.expiresAt} IS NULL OR ${pluginStorage.expiresAt} > now())`;

/**
 * Plugins' own data, per plugin for the instance or per plugin and user, within `STORE_LIMITS`.
 * Misuse rejects as the plugin API says: a `TypeError` for a bad key or value, a `RangeError`
 * past a limit.
 */
export class PluginStorageService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The store of `pluginId` for the instance (`userId` null) or for one user. */
  store(pluginId: string, userId: number | null): KeyValueStore {
    const owner = and(
      eq(pluginStorage.pluginId, pluginId),
      userId === null ? isNull(pluginStorage.userId) : eq(pluginStorage.userId, userId),
    );
    const db = this.#db;
    return {
      async get(key) {
        checkKey(key);
        const [row] = await db
          .select({ value: pluginStorage.value })
          .from(pluginStorage)
          .where(and(owner, eq(pluginStorage.key, key), live));
        return row?.value;
      },

      async set(key, value, options = {}) {
        checkKey(key);
        const json = JSON.stringify(value) as string | undefined;
        if (json === undefined) throw new TypeError('Stored values must be JSON');
        const size = Buffer.byteLength(json);
        if (size > STORE_LIMITS.valueBytes)
          throw new RangeError(
            `Stored values hold at most ${String(STORE_LIMITS.valueBytes)} bytes`,
          );
        const { ttlSeconds } = options;
        if (
          ttlSeconds !== undefined &&
          !(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS)
        )
          throw new TypeError(`ttlSeconds is a whole number from 1 to ${String(MAX_TTL_SECONDS)}`);
        const expiresAt =
          ttlSeconds === undefined ? null : sql`now() + make_interval(secs => ${ttlSeconds})`;
        await db.transaction(async (tx) => {
          // One writer per store at a time, so two cannot both pass the limits.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`plugin-storage:${pluginId}:${String(userId)}`}))`,
          );
          const [held] = await tx
            .select({
              keys: sql<number>`count(*)::int`,
              bytes: sql<number>`coalesce(sum(${pluginStorage.size}), 0)::int`,
            })
            .from(pluginStorage)
            .where(and(owner, live, sql`${pluginStorage.key} <> ${key}`));
          if ((held?.keys ?? 0) + 1 > STORE_LIMITS.keys)
            throw new RangeError(`A store holds at most ${String(STORE_LIMITS.keys)} keys`);
          if ((held?.bytes ?? 0) + size > STORE_LIMITS.bytes)
            throw new RangeError(`A store holds at most ${String(STORE_LIMITS.bytes)} bytes`);
          await tx
            .insert(pluginStorage)
            .values({ pluginId, userId, key, value: sql`${json}::jsonb`, size, expiresAt })
            .onConflictDoUpdate({
              target: [pluginStorage.pluginId, pluginStorage.userId, pluginStorage.key],
              set: { value: sql`${json}::jsonb`, size, expiresAt, updatedAt: sql`now()` },
            });
        });
      },

      async delete(key) {
        checkKey(key);
        const rows = await db
          .delete(pluginStorage)
          .where(and(owner, eq(pluginStorage.key, key)))
          .returning({ live: sql<boolean>`${live}` });
        return rows.some((row) => row.live);
      },

      async list(prefix = '', options = {}) {
        if (typeof prefix !== 'string') throw new TypeError('The prefix is a string');
        const limit = Math.min(
          Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT), 1),
          MAX_LIST_LIMIT,
        );
        const conditions: (SQL | undefined)[] = [owner, live];
        if (prefix) conditions.push(sql`starts_with(${pluginStorage.key}, ${prefix})`);
        if (options.after !== undefined) conditions.push(gt(pluginStorage.key, options.after));
        return db
          .select({ key: pluginStorage.key, value: pluginStorage.value })
          .from(pluginStorage)
          .where(and(...conditions))
          .orderBy(asc(pluginStorage.key))
          .limit(Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT);
      },
    };
  }

  /** Deletes expired values; how many. Run with the other purges. */
  async prune(): Promise<number> {
    const result = await this.#db
      .delete(pluginStorage)
      .where(lte(pluginStorage.expiresAt, sql`now()`));
    return result.rowCount ?? 0;
  }
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > STORE_LIMITS.keyLength)
    throw new TypeError(`Keys are strings of 1 to ${String(STORE_LIMITS.keyLength)} characters`);
}
