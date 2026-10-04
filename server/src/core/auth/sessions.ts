import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { sessions, users } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import { hashToken, newToken } from './tokens.ts';

export type SessionKind = 'cookie' | 'bearer';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TTL_MS: Record<SessionKind, number> = { cookie: 30 * DAY_MS, bearer: 90 * DAY_MS };
/** Sliding expiry is extended at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface NewSession {
  token: string;
  session: SessionRow;
}

export class SessionService {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async create(userId: number, kind: SessionKind, userAgent: string | null): Promise<NewSession> {
    const token = newToken();
    const now = this.#now();
    const [session] = await this.#db
      .insert(sessions)
      .values({
        userId,
        kind,
        userAgent: userAgent?.slice(0, 512) ?? null,
        tokenHash: hashToken(token),
        csrfToken: kind === 'cookie' ? newToken() : null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS[kind]),
      })
      .returning();
    if (!session) throw new Error('Session insert returned no row');
    return { token, session };
  }

  /**
   * Resolves a token to its live session and enabled user, extending the sliding expiry.
   * `refreshed` is true when the expiry moved, so cookie clients can be re-issued the cookie.
   */
  async validate(
    token: string,
  ): Promise<{ session: SessionRow; user: UserRow; refreshed: boolean } | null> {
    const now = this.#now();
    const [row] = await this.#db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          gt(sessions.expiresAt, now),
          isNull(users.disabledAt),
        ),
      );
    if (!row) return null;
    let refreshed = false;
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(now.getTime() + TTL_MS[row.session.kind]);
      await this.#db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt })
        .where(eq(sessions.id, row.session.id));
      row.session.lastSeenAt = now;
      row.session.expiresAt = expiresAt;
      refreshed = true;
    }
    return { ...row, refreshed };
  }

  list(userId: number): Promise<SessionRow[]> {
    return this.#db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, this.#now())))
      .orderBy(sessions.lastSeenAt);
  }

  async revoke(userId: number, sessionId: number): Promise<void> {
    const deleted = await this.#db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    if (deleted.length === 0) throw new DomainError('not_found', 'Session not found');
  }

  /** Revokes every session of the user, optionally keeping one. */
  async revokeAll(userId: number, exceptSessionId?: number): Promise<void> {
    await this.#db
      .delete(sessions)
      .where(
        exceptSessionId === undefined
          ? eq(sessions.userId, userId)
          : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)),
      );
  }

  async pruneExpired(): Promise<void> {
    await this.#db.delete(sessions).where(lt(sessions.expiresAt, this.#now()));
  }
}
