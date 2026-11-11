import type { PushMessage, PushSubscriptionRequest } from '@newses/shared';
import { eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pushSubscriptions } from '../../db/schema.ts';
import type { Logger, PushSender } from '../ports.ts';

/** A user gets at most one message in this long; new entries in between wait for the next. */
export const PUSH_WINDOW_SECONDS = 30 * 60;
/** Windows end this much early, so a 30-minute dispatch schedule may push on every cycle. */
const WINDOW_SLACK_SECONDS = 3 * 60;
/** How long a push service keeps a message for a device that is offline. */
const MESSAGE_TTL_SECONDS = 12 * 60 * 60;
/** A newer message replaces one the push service has not delivered yet. */
const TOPIC = 'new-entries';
/** Places a message names, and how much of each title; the message stays well under 4 KB. */
const MESSAGE_PLACES = 5;
const MAX_PLACE_TITLE_LENGTH = 80;

/**
 * Pushes each user's new unread entries to their subscribed devices (Web Push), as one message
 * per window: ingest asks for one when it delivers entries, and those that wait for the window
 * to end go out on `flush`.
 */
export class PushService {
  readonly #db: Db;
  readonly #sender: PushSender;
  readonly #logger: Logger;

  constructor(deps: { db: Db; sender: PushSender; logger: Logger }) {
    this.#db = deps.db;
    this.#sender = deps.sender;
    this.#logger = deps.logger;
  }

  /** The VAPID public key devices subscribe with. */
  get publicKey(): string {
    return this.#sender.publicKey;
  }

  /**
   * Makes `request` the session's subscription, replacing its earlier one and any other session's
   * with the same endpoint (the same browser, signed in again).
   */
  async subscribe(userId: number, sessionId: number, request: PushSubscriptionRequest) {
    await this.#db.transaction(async (tx) => {
      // A user's first device starts from now: nothing that arrived before is pushed.
      await tx.execute(sql`
        INSERT INTO push_state (user_id, watermark)
        VALUES (${userId}, (SELECT coalesce(max(id), 0) FROM user_entries))
        ON CONFLICT (user_id) DO UPDATE SET watermark = excluded.watermark, pending = false
        WHERE NOT EXISTS (
          SELECT 1 FROM push_subscriptions
          WHERE user_id = ${userId} AND session_id <> ${sessionId}
        )`);
      await tx
        .delete(pushSubscriptions)
        .where(
          or(
            eq(pushSubscriptions.sessionId, sessionId),
            eq(pushSubscriptions.endpoint, request.endpoint),
          ),
        );
      await tx.insert(pushSubscriptions).values({
        userId,
        sessionId,
        endpoint: request.endpoint,
        p256dh: request.keys.p256dh,
        auth: request.keys.auth,
      });
    });
  }

  async unsubscribe(sessionId: number): Promise<void> {
    await this.#db.delete(pushSubscriptions).where(eq(pushSubscriptions.sessionId, sessionId));
  }

  /**
   * Ingest delivered new entries to these users: those with devices get a message now, or once
   * their window ends. Never throws, so a push service's trouble never fails a fetch.
   */
  async newEntries(userIds: number[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      const ids = sql`${sql.param(userIds)}::int[]`;
      const marked = await this.#db.execute(sql`
        UPDATE push_state p SET pending = true
        WHERE p.user_id = ANY(${ids})
          AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)`);
      if (marked.rowCount) await this.#sendDue(sql`p.user_id = ANY(${ids})`);
    } catch (err) {
      this.#logger.warn({ err }, 'Could not push new entries');
    }
  }

  /** Sends what waited for its window to end; returns how many users got a message. */
  flush(): Promise<number> {
    return this.#sendDue(sql`true`);
  }

  /** Claims the pending users `condition` selects whose window has ended, and pushes to each. */
  async #sendDue(condition: SQL): Promise<number> {
    const claimed = await this.#db.execute<{
      user_id: number;
      watermark: string;
      previous: Date | null;
    }>(sql`
      UPDATE push_state p SET pending = false, last_sent_at = now()
      WHERE p.pending AND ${condition}
        AND (
          p.last_sent_at IS NULL
          OR p.last_sent_at <= now() - make_interval(secs => ${PUSH_WINDOW_SECONDS - WINDOW_SLACK_SECONDS})
        )
      RETURNING p.user_id, p.watermark, old.last_sent_at AS previous`);
    let pushed = 0;
    for (const row of claimed.rows) {
      if (await this.#push(row.user_id, Number(row.watermark), row.previous)) pushed++;
    }
    return pushed;
  }

  /** Pushes the user's unread entries above `watermark`; with none, their window stays as it was. */
  async #push(userId: number, watermark: number, previous: Date | null): Promise<boolean> {
    const { message, mark } = await this.#newEntries(userId, watermark);
    await this.#db.execute(sql`
      UPDATE push_state SET watermark = greatest(watermark, ${mark})
        ${message ? sql`` : sql`, last_sent_at = ${previous}`}
      WHERE user_id = ${userId}`);
    if (!message) return false;

    const targets = await this.#db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    const payload = JSON.stringify(message);
    const outcomes = await Promise.all(
      targets.map(async (target) => ({
        id: target.id,
        outcome: await this.#sender.send(target, payload, {
          ttlSeconds: MESSAGE_TTL_SECONDS,
          topic: TOPIC,
        }),
      })),
    );
    const ids = (wanted: string) => outcomes.filter((o) => o.outcome === wanted).map((o) => o.id);
    // Unsubscribed, uninstalled, or expired: the push service will never deliver there again.
    const gone = ids('gone');
    if (gone.length > 0)
      await this.#db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    const sent = ids('sent');
    if (sent.length > 0)
      await this.#db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: sql`now()` })
        .where(inArray(pushSubscriptions.id, sent));
    return sent.length > 0;
  }

  /**
   * The message for the user's unread entries above `watermark`, null when there are none, and
   * the highest of their entries (read or not) seen, which the next message starts after.
   */
  async #newEntries(
    userId: number,
    watermark: number,
  ): Promise<{ message: PushMessage | null; mark: number }> {
    // Entries above the watermark, found from the newest ids rather than all of the user's. Only
    // those a fetch delivered as it found them count: their user entry and entry were written in
    // one transaction, unlike a new subscription's backfill or an import.
    const rows = await this.#db.execute<{
      mark: string | null;
      subscription_id: number | null;
      category_id: number | null;
      place: string | null;
      count: number | null;
    }>(sql`
      WITH fresh AS (
        SELECT ue.id, ue.subscription_id, ue.unread AND ue.created_at = e.fetched_at AS found
        FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
        WHERE ue.id > ${watermark} AND ue.user_id = ${userId}
      )
      SELECT (SELECT max(id) FROM fresh) AS mark, f.subscription_id, s.category_id,
        coalesce(c.title, s.title, fs.title, fs.url) AS place, count(f.id)::int AS count
      FROM (SELECT 1) one
      LEFT JOIN fresh f ON f.found AND f.subscription_id IS NOT NULL
      LEFT JOIN subscriptions s ON s.id = f.subscription_id
      LEFT JOIN feed_sources fs ON fs.id = s.feed_source_id
      LEFT JOIN categories c ON c.id = s.category_id
      GROUP BY f.subscription_id, s.category_id, place`);
    const mark = Number(rows.rows[0]?.mark ?? watermark);
    const places = new Map<string, number>();
    const feeds = new Set<number>();
    const groups = new Set<number | null>();
    let count = 0;
    for (const row of rows.rows) {
      if (row.subscription_id === null || !row.count) continue;
      count += row.count;
      feeds.add(row.subscription_id);
      groups.add(row.category_id);
      // Cut without leaving half of a surrogate pair.
      const place = (row.place ?? '')
        .slice(0, MAX_PLACE_TITLE_LENGTH)
        .replace(/[\uD800-\uDBFF]$/, '');
      places.set(place, (places.get(place) ?? 0) + row.count);
    }
    if (count === 0) return { message: null, mark };

    const [feed] = feeds;
    const [group] = groups;
    // One feed, else one category (`c0`: uncategorised), else everything.
    let target = '/all';
    if (feeds.size === 1 && feed !== undefined) target = `/f${String(feed)}`;
    else if (groups.size === 1 && group !== undefined) target = `/c${String(group ?? 0)}`;
    const ranked = [...places]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([title, n]) => ({ title, count: n }));
    return {
      message: {
        type: 'new-entries',
        count,
        places: ranked.slice(0, MESSAGE_PLACES),
        morePlaces: Math.max(0, ranked.length - MESSAGE_PLACES),
        target,
      },
      mark,
    };
  }
}
