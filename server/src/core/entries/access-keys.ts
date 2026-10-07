import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { accessKeys, users } from '../../db/schema.ts';

/** What an access key opens; generated feeds (Later) add purposes. */
export type AccessKeyPurpose = 'published';

const newKey = () => randomBytes(32).toString('base64url');

/** Secret keys for public URLs, one per user and purpose, created on first use. */
export class AccessKeyService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(userId: number, purpose: AccessKeyPurpose): Promise<string> {
    await this.#db
      .insert(accessKeys)
      .values({ userId, purpose, key: newKey() })
      .onConflictDoNothing({ target: [accessKeys.userId, accessKeys.purpose] });
    const [row] = await this.#db
      .select({ key: accessKeys.key })
      .from(accessKeys)
      .where(and(eq(accessKeys.userId, userId), eq(accessKeys.purpose, purpose)));
    if (!row) throw new Error('Access key insert returned no row');
    return row.key;
  }

  /** Replaces the key, so URLs with the old one stop working. */
  async regenerate(userId: number, purpose: AccessKeyPurpose): Promise<string> {
    const key = newKey();
    await this.#db
      .insert(accessKeys)
      .values({ userId, purpose, key })
      .onConflictDoUpdate({
        target: [accessKeys.userId, accessKeys.purpose],
        set: { key, createdAt: sql`now()` },
      });
    return key;
  }

  /** The user a key belongs to, unless they are disabled. */
  async resolve(key: string, purpose: AccessKeyPurpose): Promise<number | null> {
    const [row] = await this.#db
      .select({ userId: accessKeys.userId })
      .from(accessKeys)
      .innerJoin(users, eq(users.id, accessKeys.userId))
      .where(
        and(eq(accessKeys.key, key), eq(accessKeys.purpose, purpose), isNull(users.disabledAt)),
      );
    return row?.userId ?? null;
  }
}
