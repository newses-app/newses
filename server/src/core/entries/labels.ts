import type { CreateLabelRequest, UpdateLabelRequest } from '@newses/shared';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { entryLabels, labels, userEntries } from '../../db/schema.ts';
import { isUniqueViolation } from '../db-errors.ts';
import { DomainError } from '../errors.ts';
import type { Realtime } from '../ports.ts';

export type LabelRow = typeof labels.$inferSelect;

/** User-defined labels and their assignment to entries. Each label is also a stream. */
export class LabelService {
  readonly #db: Db;
  readonly #realtime: Realtime;

  constructor(db: Db, realtime: Realtime) {
    this.#db = db;
    this.#realtime = realtime;
  }

  list(userId: number): Promise<LabelRow[]> {
    return this.#db
      .select()
      .from(labels)
      .where(eq(labels.userId, userId))
      .orderBy(asc(sql`lower(${labels.caption})`), asc(labels.id));
  }

  async create(userId: number, label: CreateLabelRequest): Promise<LabelRow> {
    return this.#unique(label.caption, async () => {
      const [row] = await this.#db
        .insert(labels)
        .values({ userId, ...label })
        .returning();
      if (!row) throw new Error('Label insert returned no row');
      return row;
    });
  }

  async update(userId: number, id: number, changes: UpdateLabelRequest): Promise<LabelRow> {
    const owned = and(eq(labels.id, id), eq(labels.userId, userId));
    return this.#unique(changes.caption ?? '', async () => {
      const [row] =
        Object.keys(changes).length > 0
          ? await this.#db.update(labels).set(changes).where(owned).returning()
          : await this.#db.select().from(labels).where(owned);
      if (!row) throw new DomainError('not_found', 'Label not found');
      return row;
    });
  }

  /** Deletes a label and removes it from its entries. */
  async delete(userId: number, id: number): Promise<void> {
    const deleted = await this.#db
      .delete(labels)
      .where(and(eq(labels.id, id), eq(labels.userId, userId)))
      .returning({ id: labels.id });
    if (deleted.length === 0) throw new DomainError('not_found', 'Label not found');
    await this.#realtime.publish(userId, { type: 'counters' });
  }

  /** Replaces the labels on one of the user's entries. */
  async setEntryLabels(userId: number, entryId: number, labelIds: number[]): Promise<void> {
    const wanted = [...new Set(labelIds)];
    const { changed, unread } = await this.#db.transaction(async (tx) => {
      const [entry] = await tx
        .select({ unread: userEntries.unread })
        .from(userEntries)
        .where(and(eq(userEntries.id, entryId), eq(userEntries.userId, userId)));
      if (!entry) throw new DomainError('not_found', 'Entry not found');
      if (wanted.length > 0) {
        const owned = await tx
          .select({ id: labels.id })
          .from(labels)
          .where(and(eq(labels.userId, userId), inArray(labels.id, wanted)));
        if (owned.length !== wanted.length) throw new DomainError('not_found', 'Label not found');
      }
      const removed = await tx
        .delete(entryLabels)
        .where(
          and(
            eq(entryLabels.userEntryId, entryId),
            wanted.length > 0 ? notInArray(entryLabels.labelId, wanted) : undefined,
          ),
        )
        .returning({ id: entryLabels.labelId });
      const added =
        wanted.length > 0
          ? await tx
              .insert(entryLabels)
              .values(wanted.map((labelId) => ({ userEntryId: entryId, labelId })))
              .onConflictDoNothing()
              .returning({ id: entryLabels.labelId })
          : [];
      return { changed: removed.length + added.length > 0, unread: entry.unread };
    });
    if (changed && unread) await this.#realtime.publish(userId, { type: 'counters' });
  }

  /**
   * Adds and removes labels on one of the user's entries, keeping the others; labels that do not
   * exist (any more) are ignored. Returns the entry's labels.
   */
  async changeEntryLabels(
    userId: number,
    entryId: number,
    change: { add: number[]; remove: number[] },
  ): Promise<number[]> {
    const [current, owned] = await Promise.all([
      this.#db
        .select({ id: entryLabels.labelId })
        .from(entryLabels)
        .where(eq(entryLabels.userEntryId, entryId)),
      change.add.length > 0
        ? this.#db
            .select({ id: labels.id })
            .from(labels)
            .where(and(eq(labels.userId, userId), inArray(labels.id, change.add)))
        : [],
    ]);
    const gone = new Set(change.remove);
    const wanted = [
      ...new Set([
        ...current.map((l) => l.id).filter((id) => !gone.has(id)),
        ...owned.map((l) => l.id),
      ]),
    ].sort((a, b) => a - b);
    await this.setEntryLabels(userId, entryId, wanted);
    return wanted;
  }

  async #unique<T>(caption: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err))
        throw new DomainError('conflict', `A label named "${caption}" already exists`);
      throw err;
    }
  }
}
