import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { appPasswords } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import { hashToken } from './tokens.ts';
import { base32Encode } from './totp.ts';

export type AppPasswordRow = typeof appPasswords.$inferSelect;

const MAX_PER_USER = 50;
/** Last-used time is written at most this often, to avoid a write per API call. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Typed on phones, so dashes and case are ignored. */
const normalize = (password: string) => password.toLowerCase().replace(/[^a-z2-7]/g, '');

/** 160 bits shown as `xxxx-xxxx-…` (8 groups of 4). */
function newAppPassword(): string {
  return (base32Encode(randomBytes(20)).toLowerCase().match(/.{4}/g) ?? []).join('-');
}

/** Named passwords for compatibility-API clients; see AuthService for authentication. */
export class AppPasswordService {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /** Creates one and returns its password, which is not stored and cannot be shown again. */
  async create(
    userId: number,
    name: string,
  ): Promise<{ appPassword: AppPasswordRow; password: string }> {
    const [existing] = await this.#db
      .select({ n: count() })
      .from(appPasswords)
      .where(eq(appPasswords.userId, userId));
    if ((existing?.n ?? 0) >= MAX_PER_USER) {
      throw new DomainError('invalid_input', `At most ${String(MAX_PER_USER)} app passwords`);
    }
    const password = newAppPassword();
    const [appPassword] = await this.#db
      .insert(appPasswords)
      .values({ userId, name, tokenHash: hashToken(normalize(password)) })
      .returning();
    if (!appPassword) throw new Error('App password insert returned no row');
    return { appPassword, password };
  }

  list(userId: number): Promise<AppPasswordRow[]> {
    return this.#db
      .select()
      .from(appPasswords)
      .where(eq(appPasswords.userId, userId))
      .orderBy(asc(appPasswords.createdAt), asc(appPasswords.id));
  }

  async revoke(userId: number, id: number): Promise<void> {
    const deleted = await this.#db
      .delete(appPasswords)
      .where(and(eq(appPasswords.id, id), eq(appPasswords.userId, userId)))
      .returning({ id: appPasswords.id });
    if (deleted.length === 0) throw new DomainError('not_found', 'App password not found');
  }

  async revokeAll(userId: number): Promise<void> {
    await this.#db.delete(appPasswords).where(eq(appPasswords.userId, userId));
  }

  /** The user's app password matching `password`, marking it used; null when none matches. */
  async match(userId: number, password: string): Promise<AppPasswordRow | null> {
    const [row] = await this.#db
      .select()
      .from(appPasswords)
      .where(
        and(
          eq(appPasswords.userId, userId),
          eq(appPasswords.tokenHash, hashToken(normalize(password))),
        ),
      );
    if (!row) return null;
    const now = this.#now();
    await this.#db
      .update(appPasswords)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(appPasswords.id, row.id),
          or(
            isNull(appPasswords.lastUsedAt),
            lt(appPasswords.lastUsedAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
    return row;
  }
}
