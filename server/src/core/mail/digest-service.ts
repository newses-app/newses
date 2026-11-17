import { nextOccurrence, type Prefs } from '@newses/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { digestState, users } from '../../db/schema.ts';
import { ownerLocale } from '../../i18n.ts';
import { sign, verify } from '../crypto.ts';
import {
  type EntryService,
  HEADLINE_FROM,
  type HeadlineRow,
  headlineColumns,
  toEntry,
} from '../entries/entries.ts';
import { shownCondition } from '../entries/streams.ts';
import type { DigestAddition, DigestComposer } from '../plugins/catalog.ts';
import { readPluginEntries } from '../plugins/entries.ts';
import type { Logger, Mailer } from '../ports.ts';
import type { PrefsService } from '../prefs.ts';
import { type DigestEntry, digestMail, groupDigest } from './digest-mail.ts';

/** Entries a digest lists at most; the rest are counted. */
export const DIGEST_MAX_ENTRIES = 100;
/** Users one run sends to at most; the rest wait for the next run. */
export const DIGEST_BATCH = 50;
/** A claimed user whose digest failed part way is tried again after this. */
const LEASE_SECONDS = 60 * 60;

export interface DigestDeps {
  db: Db;
  /** Null when the server has no mail configured. */
  mailer: Mailer | null;
  prefs: PrefsService;
  entries: EntryService;
  /** Origin of the web app the digest links to; null when unknown, which stops digests. */
  publicUrl: string | null;
  /** Signs unsubscribe links. */
  unsubscribeKey: Buffer;
  logger: Logger;
  /** Plugins' additions to digests; none without it. */
  composer?: DigestComposer | null;
  now?: () => Date;
}

/** When the user's next digest is due, from their preferences; null with digests off. */
export function nextDigest(prefs: Prefs, now: Date): Date | null {
  if (prefs.digestFrequency === 'off') return null;
  return nextOccurrence(
    now,
    prefs.timeZone ?? 'UTC',
    prefs.digestHour,
    prefs.digestFrequency === 'weekly' ? prefs.digestWeekday : null,
  );
}

/**
 * Emails users who turned it on a digest of the unread entries that came in since their last,
 * daily or weekly at their hour, to their confirmed address. Each user's state holds the highest
 * entry id a digest covered and when the next is due.
 */
export class DigestService {
  readonly #db: Db;
  readonly #mailer: Mailer | null;
  readonly #prefs: PrefsService;
  readonly #entries: EntryService;
  readonly #publicUrl: string | null;
  readonly #key: Buffer;
  readonly #logger: Logger;
  readonly #composer: DigestComposer | null;
  readonly #now: () => Date;

  constructor(deps: DigestDeps) {
    this.#db = deps.db;
    this.#mailer = deps.mailer;
    this.#prefs = deps.prefs;
    this.#entries = deps.entries;
    this.#publicUrl = deps.publicUrl;
    this.#key = deps.unsubscribeKey;
    this.#logger = deps.logger;
    this.#composer = deps.composer ?? null;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Whether digests go out: the server has mail, and a public URL for their links. */
  get enabled(): boolean {
    return this.#mailer !== null && this.#publicUrl !== null;
  }

  /**
   * Sets when the user's next digest is due after their preferences changed; turning digests on
   * starts after the entries they have now, and turning them off forgets the state.
   */
  async schedule(userId: number): Promise<void> {
    const next = nextDigest(await this.#prefs.get(userId), this.#now());
    if (!next) {
      await this.#db.delete(digestState).where(eq(digestState.userId, userId));
      return;
    }
    await this.#db.execute(sql`
      INSERT INTO digest_state (user_id, watermark, next_due_at)
      VALUES (${userId}, (SELECT coalesce(max(id), 0) FROM user_entries WHERE user_id = ${userId}),
        ${next.toISOString()}::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET next_due_at = excluded.next_due_at`);
  }

  /** The token in a user's unsubscribe link. */
  unsubscribeToken(userId: number): string {
    return `${String(userId)}.${sign(this.#key, `digest:${String(userId)}`)}`;
  }

  /** The user an unsubscribe token is for; null when it is not one this server made. */
  tokenUser(token: string): number | null {
    const [id, mac, ...rest] = token.split('.');
    if (!id || !mac || rest.length > 0 || !/^\d{1,10}$/.test(id)) return null;
    return verify(this.#key, `digest:${id}`, mac) ? Number(id) : null;
  }

  /** Turns the token's user's digests off; false for a token this server did not make. */
  async unsubscribe(token: string): Promise<boolean> {
    const userId = this.tokenUser(token);
    if (userId === null) return false;
    const [user] = await this.#db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) return false;
    await this.#prefs.update(userId, { digestFrequency: 'off' });
    await this.#db.delete(digestState).where(eq(digestState.userId, userId));
    return true;
  }

  /**
   * Sends the digests that are due, to at most `limit` users, starting none after `deadline` (ms
   * since the epoch; users it does not reach stay due); returns how many were sent. Users with
   * digests on but no state (after a restore, which leaves it out) start from now.
   */
  async sendDue({
    limit = DIGEST_BATCH,
    deadline = Infinity,
  }: { limit?: number; deadline?: number } = {}): Promise<number> {
    const mailer = this.#mailer;
    const appUrl = this.#publicUrl;
    if (!mailer || !appUrl) return 0;
    const now = this.#now();
    const at = sql`${now.toISOString()}::timestamptz`;
    await this.#db.execute(sql`
      INSERT INTO digest_state (user_id, watermark, next_due_at)
      SELECT p.user_id,
        (SELECT coalesce(max(ue.id), 0) FROM user_entries ue WHERE ue.user_id = p.user_id), ${at}
      FROM user_prefs p
      WHERE p.key = 'digestFrequency' AND p.value #>> '{}' IN ('daily', 'weekly')
      ON CONFLICT (user_id) DO NOTHING`);
    const claimed = await this.#db.execute<{ user_id: number; watermark: string }>(sql`
      UPDATE digest_state d SET next_due_at = ${at} + make_interval(secs => ${LEASE_SECONDS})
      FROM (
        SELECT user_id FROM digest_state WHERE next_due_at <= ${at}
        ORDER BY next_due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) due
      WHERE d.user_id = due.user_id
      RETURNING d.user_id, d.watermark`);
    let sent = 0;
    for (const [index, row] of claimed.rows.entries()) {
      if (Date.now() >= deadline) {
        const left = claimed.rows.slice(index).map((r) => r.user_id);
        await this.#db.execute(sql`
          UPDATE digest_state SET next_due_at = ${at}
          WHERE user_id = ANY(${sql.param(left)}::int[])`);
        break;
      }
      try {
        if (await this.#send(mailer, appUrl, row.user_id, Number(row.watermark), now)) sent++;
      } catch (err) {
        // The lease runs out and the next run tries again.
        this.#logger.warn({ err, userId: row.user_id }, 'digest failed');
      }
    }
    return sent;
  }

  /** The user's digest, if it has entries and they can be mailed; then their next one is set. */
  async #send(
    mailer: Mailer,
    appUrl: string,
    userId: number,
    watermark: number,
    now: Date,
  ): Promise<boolean> {
    const prefs = await this.#prefs.get(userId);
    const next = nextDigest(prefs, now);
    if (!next) {
      await this.#db.delete(digestState).where(eq(digestState.userId, userId));
      return false;
    }
    const [user] = await this.#db
      .select({ login: users.login, email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId));
    // Every entry above the watermark counts as seen, read or not; unread ones shown in All are
    // the digest's.
    const shown = shownCondition(userId, { special: 'all' });
    const [found] = (
      await this.#db.execute<{ mark: string | null; count: number }>(sql`
        SELECT max(ue.id) AS mark, (count(*) FILTER (WHERE ue.unread AND ${shown}))::int AS count
        FROM user_entries ue WHERE ue.user_id = ${userId} AND ue.id > ${watermark}`)
    ).rows;
    const mark = Number(found?.mark ?? watermark);
    const count = found?.count ?? 0;
    /** The next digest set; with `seen`, starting after these entries; `sent` records the time. */
    const moveOn = ({ seen = false, sent = false } = {}) =>
      this.#db.execute(sql`
        UPDATE digest_state SET next_due_at = ${next.toISOString()}::timestamptz
          ${seen ? sql`, watermark = greatest(watermark, ${mark})` : sql``}
          ${sent ? sql`, last_sent_at = ${now.toISOString()}::timestamptz` : sql``}
        WHERE user_id = ${userId}`);
    // Without an address to send to, what came in waits for the first digest that has one.
    if (!user?.email || user.disabledAt) {
      await moveOn();
      return false;
    }
    if (count === 0) {
      await moveOn({ seen: true });
      return false;
    }

    const rows = await this.#db.execute<HeadlineRow & { category_title: string | null }>(sql`
      SELECT ${headlineColumns(false)}, c.title AS category_title
      FROM ${HEADLINE_FROM}
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE ue.id > ${watermark} AND ue.id <= ${mark} AND ue.unread AND ${shown}
      ORDER BY ue.sort_at DESC, ue.id DESC
      LIMIT ${DIGEST_MAX_ENTRIES}`);
    const listed: DigestEntry[] = rows.rows.map((row) => ({
      ...toEntry(row),
      categoryTitle: row.category_title,
    }));
    const locale = ownerLocale(prefs.language);
    const frequency = prefs.digestFrequency === 'weekly' ? 'weekly' : 'daily';
    const additions = await this.#compose({
      userId,
      language: locale,
      frequency,
      listed,
      more: count - listed.length,
    });
    const unsubscribeUrl = `${appUrl}/public/unsubscribe/${this.unsubscribeToken(userId)}`;
    try {
      await mailer.send({
        to: [user.email],
        unsubscribeUrl,
        ...digestMail({
          locale,
          login: user.login,
          appUrl,
          groups: groupDigest(listed, locale),
          more: count - listed.length,
          additions,
          frequency,
          hour: prefs.digestHour,
          weekday: prefs.digestWeekday,
          timeZone: prefs.timeZone ?? 'UTC',
          markedRead: prefs.digestMarkRead,
          unsubscribeUrl,
        }),
      });
    } catch (err) {
      // What came in waits for the next digest.
      this.#logger.warn({ err, userId }, 'digest email failed');
      await moveOn();
      return false;
    }
    if (prefs.digestMarkRead)
      await this.#entries.setState(
        userId,
        listed.map((entry) => entry.id),
        { unread: false },
      );
    await moveOn({ seen: true, sent: true });
    return true;
  }

  /** What the plugins on for the user add to their digest; none when that fails. */
  async #compose(digest: {
    userId: number;
    language: string;
    frequency: 'daily' | 'weekly';
    listed: DigestEntry[];
    more: number;
  }): Promise<DigestAddition[]> {
    const composer = this.#composer;
    if (!composer?.composes) return [];
    const { userId, listed } = digest;
    try {
      const excerpts = new Map(listed.map((entry) => [entry.id, entry.excerpt]));
      const read = await readPluginEntries(
        this.#db,
        userId,
        listed.map((entry) => entry.id),
        { text: false },
      );
      return await composer.compose({
        userId,
        language: digest.language,
        frequency: digest.frequency,
        entries: read.map(({ entry, contentHash }) => ({
          ...entry,
          excerpt: excerpts.get(entry.id) ?? null,
          contentHash,
        })),
        more: digest.more,
      });
    } catch (err) {
      this.#logger.warn({ err, userId }, 'digest additions failed');
      return [];
    }
  }
}
