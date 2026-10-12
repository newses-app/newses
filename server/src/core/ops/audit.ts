import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.ts';
import { auditEvents, users } from '../../db/schema.ts';
import type { Logger } from '../ports.ts';

export interface AuditEntry {
  event: string;
  /** The account the event concerns. */
  userId: number | null;
  /** The signed-in user who acted, when that is someone else. */
  actorUserId: number | null;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  at: Date;
  userLogin: string | null;
  actorLogin: string | null;
}

export interface AuditQuery {
  /** Only events older than this id (the previous page's last). */
  before?: number | undefined;
  limit: number;
  event?: string | undefined;
  userId?: number | undefined;
}

const actors = alias(users, 'actors');

/** Persists security events. Writes never block or fail the request that caused them. */
export class AuditLog {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #pending = new Set<Promise<void>>();

  constructor(db: Db, logger: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  record(entry: AuditEntry): void {
    // The account may already be gone (`user_deleted`); its id stays in the details.
    const existing = (id: number | null) =>
      id === null ? null : sql<number>`(SELECT id FROM users WHERE id = ${id})`;
    const write = this.#db
      .insert(auditEvents)
      .values({
        ...entry,
        userId: existing(entry.userId),
        actorUserId: existing(entry.actorUserId),
        details: {
          ...entry.details,
          ...(entry.userId !== null && { userId: entry.userId }),
        },
      })
      .then(
        () => undefined,
        (err: unknown) => {
          this.#logger.error({ err, event: entry.event }, 'Audit event write failed');
        },
      )
      .finally(() => this.#pending.delete(write));
    this.#pending.add(write);
  }

  /** Waits for writes in flight, e.g. before a Lambda invocation returns. */
  async settle(): Promise<void> {
    await Promise.all(this.#pending);
  }

  /** Newest first. */
  async list(query: AuditQuery): Promise<AuditRecord[]> {
    const conditions = [
      query.before !== undefined ? lt(auditEvents.id, query.before) : undefined,
      query.event !== undefined ? eq(auditEvents.event, query.event) : undefined,
      query.userId !== undefined ? eq(auditEvents.userId, query.userId) : undefined,
    ];
    const rows = await this.#db
      .select({
        id: auditEvents.id,
        at: auditEvents.at,
        event: auditEvents.event,
        userId: auditEvents.userId,
        actorUserId: auditEvents.actorUserId,
        ip: auditEvents.ip,
        userAgent: auditEvents.userAgent,
        details: auditEvents.details,
        userLogin: users.login,
        actorLogin: actors.login,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.userId))
      .leftJoin(actors, eq(actors.id, auditEvents.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(auditEvents.id))
      .limit(query.limit);
    return rows.map((row) => ({ ...row, details: row.details as Record<string, unknown> }));
  }

  async prune(days: number): Promise<number> {
    const result = await this.#db
      .delete(auditEvents)
      .where(sql`${auditEvents.at} < now() - make_interval(days => ${days})`);
    return result.rowCount ?? 0;
  }
}
