import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { fetchHosts } from '../../db/schema.ts';
import type { HostLimiter } from './host-limiter.ts';
import { type Fetcher, FetchError, type FetchRequest, type FetchResult } from './http.ts';
import { hostOf } from './url.ts';

/** A host that answers 429 without Retry-After is left alone this long. */
export const DEFAULT_HOST_COOLDOWN_SECONDS = 10 * 60;

/** HTTP 429, or 503 with Retry-After: the host asks every client to wait. */
export const isHostThrottle = (err: FetchError) =>
  err.status === 429 || (err.status === 503 && err.retryAfterSeconds !== null);

/**
 * Every request to a remote host goes through here: within the per-host limits, never to a host
 * that asked to wait, and a host that asks (HTTP 429, or 503 with Retry-After) is recorded in
 * `fetch_hosts`, so every process leaves it alone until then. A paused host fails with
 * `host_blocked` and its `retryAfterSeconds`.
 */
export class PoliteFetcher implements Fetcher {
  readonly #db: Db;
  readonly #fetcher: Fetcher;
  readonly #hosts: HostLimiter;

  constructor(deps: { db: Db; fetcher: Fetcher; hosts: HostLimiter }) {
    this.#db = deps.db;
    this.#fetcher = deps.fetcher;
    this.#hosts = deps.hosts;
  }

  fetch(url: string, request?: FetchRequest): Promise<FetchResult> {
    const host = hostOf(url);
    // Checked once a slot is free, so requests queued behind a 429 see it.
    return this.#hosts.run(host, async () => {
      const blocked = await this.blockedSeconds(host);
      if (blocked > 0)
        throw new FetchError('host_blocked', `${host} asked to wait before more requests`, {
          retryAfterSeconds: blocked,
        });
      try {
        return await this.#fetcher.fetch(url, request);
      } catch (err) {
        if (err instanceof FetchError && isHostThrottle(err))
          await this.#block(
            err.url ? hostOf(err.url) : host,
            err.retryAfterSeconds ?? DEFAULT_HOST_COOLDOWN_SECONDS,
          );
        throw err;
      }
    });
  }

  /** Seconds until `host` may be fetched again; 0 when it has not asked to wait. */
  async blockedSeconds(host: string): Promise<number> {
    const [row] = await this.#db
      .select({
        seconds: sql<number>`ceil(extract(epoch FROM ${fetchHosts.blockedUntil} - now()))::int`,
      })
      .from(fetchHosts)
      .where(and(eq(fetchHosts.host, host), sql`${fetchHosts.blockedUntil} > now()`));
    return row?.seconds ?? 0;
  }

  async #block(host: string, seconds: number): Promise<void> {
    const until = sql`now() + make_interval(secs => ${seconds})`;
    await this.#db
      .insert(fetchHosts)
      .values({ host, blockedUntil: until })
      .onConflictDoUpdate({
        target: fetchHosts.host,
        set: {
          blockedUntil: sql`greatest(${fetchHosts.blockedUntil}, excluded.blocked_until)`,
        },
      });
  }
}
