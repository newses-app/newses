import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { ThrottledError } from './errors.ts';

/**
 * User actions limited per user: those that make the server or a plugin fetch from a remote host, OPML
 * imports, which write many rows at once, mail to addresses not yet confirmed, test digests, and plugins' actions.
 */
export type LimitedAction =
  | 'fulltext'
  | 'subscribe'
  | 'page'
  | 'debug'
  | 'import'
  | 'emailConfirm'
  | 'emailArticle'
  | 'pluginTest'
  | 'digestTest'
  | 'pluginAction';

/** Each action's requests per user per WINDOW_SECONDS. */
export const RATE_LIMITS: Record<LimitedAction, number> = {
  fulltext: 20,
  subscribe: 10,
  page: 10,
  debug: 5,
  import: 5,
  emailConfirm: 3,
  emailArticle: 5,
  pluginTest: 5,
  digestTest: 3,
  pluginAction: 10,
};

const WINDOW_SECONDS = 60;

/**
 * Limits how often each user takes costly actions, such as making the server fetch on their
 * behalf, in windows counted in Postgres, so the limit holds across processes.
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

  /**
   * Seconds left in the window when the request is over the limit, else 0. A window starts at
   * the first request after the last one ended, so a burst is counted in one window wherever it
   * falls on the clock.
   */
  async #count(userId: number, action: LimitedAction): Promise<number> {
    const open = sql`${rateLimits.windowStart} > now() - make_interval(secs => ${WINDOW_SECONDS})`;
    const [row] = await this.#db
      .insert(rateLimits)
      .values({ key: `${action}:${String(userId)}`, windowStart: sql`now()`, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`CASE WHEN ${open} THEN ${rateLimits.count} + 1 ELSE 1 END`,
          windowStart: sql`CASE WHEN ${open} THEN ${rateLimits.windowStart} ELSE excluded.window_start END`,
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
