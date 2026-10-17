import { normaliseTags, type TagCount } from '@newses/shared';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { entryTags, userEntries } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';

/** Free-text tags on entries; feed categories arrive as tags at fan-out (see `Ingester`). */
export class TagService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The user's tags with how many entries carry each, alphabetically. */
  async list(userId: number): Promise<TagCount[]> {
    const rows = await this.#db
      .select({ tag: entryTags.tag, count: sql<number>`count(*)::int` })
      .from(entryTags)
      .where(eq(entryTags.userId, userId))
      .groupBy(entryTags.tag)
      .orderBy(entryTags.tag);
    return rows;
  }

  /** Replaces the tags on one of the user's entries; returns them normalised and sorted. */
  async setEntryTags(userId: number, entryId: number, tags: string[]): Promise<string[]> {
    const wanted = normaliseTags(tags);
    await this.#db.transaction(async (tx) => {
      const [entry] = await tx
        .select({ id: userEntries.id })
        .from(userEntries)
        .where(and(eq(userEntries.id, entryId), eq(userEntries.userId, userId)));
      if (!entry) throw new DomainError('not_found', 'Entry not found');
      await tx
        .delete(entryTags)
        .where(
          and(
            eq(entryTags.userEntryId, entryId),
            wanted.length > 0 ? notInArray(entryTags.tag, wanted) : undefined,
          ),
        );
      if (wanted.length > 0)
        await tx
          .insert(entryTags)
          .values(wanted.map((tag) => ({ userEntryId: entryId, userId, tag })))
          .onConflictDoNothing();
    });
    return wanted.sort();
  }

  /** Adds and removes tags on one of the user's entries, keeping the others; returns them all. */
  async changeEntryTags(
    userId: number,
    entryId: number,
    change: { add: string[]; remove: string[] },
  ): Promise<string[]> {
    const current = await this.#db
      .select({ tag: entryTags.tag })
      .from(entryTags)
      .where(and(eq(entryTags.userEntryId, entryId), eq(entryTags.userId, userId)))
      .orderBy(entryTags.tag);
    const gone = new Set(normaliseTags(change.remove));
    const kept = current.map((r) => r.tag).filter((tag) => !gone.has(tag));
    return this.setEntryTags(userId, entryId, [...kept, ...change.add]);
  }
}
