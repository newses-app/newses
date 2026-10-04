import { eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { loginAttempts } from '../../db/schema.ts';
import { ThrottledError } from '../errors.ts';

export interface ThrottleRule {
  /** Failures allowed before lockouts start. */
  threshold: number;
}

const MAX_LOCK_SECONDS = 15 * 60;

/** Lock duration doubles with each failure past the threshold: 1 s, 2 s, 4 s, … up to 15 min. */
export function lockSeconds(failures: number, rule: ThrottleRule): number {
  if (failures < rule.threshold) return 0;
  return Math.min(MAX_LOCK_SECONDS, 2 ** (failures - rule.threshold));
}

export class LoginThrottle {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /** Throws ThrottledError if any key is currently locked. */
  async check(keys: string[]): Promise<void> {
    const rows = await this.#db
      .select({ lockedUntil: loginAttempts.lockedUntil })
      .from(loginAttempts)
      .where(inArray(loginAttempts.key, keys));
    const now = this.#now().getTime();
    const waitMs = Math.max(0, ...rows.map((r) => (r.lockedUntil?.getTime() ?? 0) - now));
    if (waitMs > 0) throw new ThrottledError(Math.ceil(waitMs / 1000));
  }

  async recordFailure(key: string, rule: ThrottleRule): Promise<void> {
    const [row] = await this.#db
      .insert(loginAttempts)
      .values({ key, failures: 1 })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: { failures: sql`${loginAttempts.failures} + 1`, updatedAt: sql`now()` },
      })
      .returning({ failures: loginAttempts.failures });
    const seconds = lockSeconds(row?.failures ?? 1, rule);
    if (seconds > 0) {
      await this.#db
        .update(loginAttempts)
        .set({ lockedUntil: new Date(this.#now().getTime() + seconds * 1000) })
        .where(eq(loginAttempts.key, key));
    }
  }

  async reset(key: string): Promise<void> {
    await this.#db.delete(loginAttempts).where(eq(loginAttempts.key, key));
  }

  /** Removes counters untouched for a day. */
  async prune(): Promise<void> {
    const cutoff = new Date(this.#now().getTime() - 24 * 60 * 60 * 1000);
    await this.#db.delete(loginAttempts).where(lt(loginAttempts.updatedAt, cutoff));
  }
}
