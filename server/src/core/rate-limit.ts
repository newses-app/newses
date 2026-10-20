import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { ThrottledError } from './errors.ts';

/**
 * User actions limited per user: those that make the server fetch from a remote host, and OPML
 * imports, which write many rows at once.
 */
export type LimitedAction = 'fulltext' | 'subscribe' | 'page' | 'debug' | 'import';

/** Each action's requests per user per WINDOW_SECONDS. */
export const RATE_LIMITS: Record<LimitedAction, number> = {
  fulltext: 20,
  subscribe: 10,
  page: 10,
  debug: 5,
  import: 5,
};

const WINDOW_SECONDS = 60;

/**
 * Limits how often each user takes costly actions, such as making the server fetch on their
 * behalf, in fixed windows counted in Postgres, so the limit holds across processes.
 */
export class UserRateLimiter {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Counts a request; throws ThrottledError, with the seconds left in the window, past the limit. */
  async take(userId: number, action: LimitedAction): Promise<void> {
    const wait = await this.#count(userId, action);
    if (wait > 0) throw new ThrottledError(wait, 'Too many requests; try again shortly');
  }

  /** Counts a request; false past the limit. */
  async tryTake(userId: number, action: LimitedAction): Promise<boolean> {
    return (await this.#count(userId, action)) === 0;
  }

  /** Removes windows that ended over an hour ago. */
  async prune(): Promise<void> {
    await this.#db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, sql`now() - interval '1 hour'`));
  }

  /** Seconds left in the window when the request is over the limit, else 0. */
  async #count(userId: number, action: LimitedAction): Promise<number> {
    const window = sql`date_bin(make_interval(secs => ${WINDOW_SECONDS}), now(), 'epoch'::timestamptz)`;
    const [row] = await this.#db
      .insert(rateLimits)
      .values({ key: `${action}:${String(userId)}`, windowStart: window, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`CASE WHEN ${rateLimits.windowStart} = excluded.window_start
            THEN ${rateLimits.count} + 1 ELSE 1 END`,
          windowStart: sql`excluded.window_start`,
        },
      })
      .returning({
        count: rateLimits.count,
        wait: sql<number>`ceil(extract(epoch FROM ${rateLimits.windowStart}
          + make_interval(secs => ${WINDOW_SECONDS}) - now()))::int`,
      });
    return (row?.count ?? 0) > RATE_LIMITS[action] ? Math.max(1, row?.wait ?? WINDOW_SECONDS) : 0;
  }
}
