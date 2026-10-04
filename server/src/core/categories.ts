import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { categories, subscriptions } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { isUniqueViolation } from './db-errors.ts';

export type CategoryRow = typeof categories.$inferSelect;

export interface CategoryChanges {
  title?: string;
  parentId?: number | null;
  sortOrder?: number;
  collapsed?: boolean;
}

export class CategoryService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(userId: number): Promise<CategoryRow[]> {
    return this.#db
      .select()
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.sortOrder), asc(categories.title));
  }

  async create(
    userId: number,
    title: string,
    parentId: number | null = null,
  ): Promise<CategoryRow> {
    if (parentId !== null) await this.#owned(userId, parentId);
    return this.#unique(title, async () => {
      const [row] = await this.#db
        .insert(categories)
        .values({ userId, title, parentId })
        .returning();
      if (!row) throw new Error('Category insert returned no row');
      return row;
    });
  }

  async update(userId: number, id: number, changes: CategoryChanges): Promise<CategoryRow> {
    const current = await this.#owned(userId, id);
    if (changes.parentId != null) await this.#assertNotDescendant(userId, id, changes.parentId);
    return this.#unique(changes.title ?? current.title, async () => {
      const [row] = await this.#db
        .update(categories)
        .set({
          ...(changes.title !== undefined && { title: changes.title }),
          ...(changes.parentId !== undefined && { parentId: changes.parentId }),
          ...(changes.sortOrder !== undefined && { sortOrder: changes.sortOrder }),
          ...(changes.collapsed !== undefined && { collapsed: changes.collapsed }),
        })
        .where(eq(categories.id, id))
        .returning();
      if (!row) throw new DomainError('not_found', 'Category not found');
      return row;
    });
  }

  /** Deletes a category; its feeds and child categories move up to its parent. */
  async delete(userId: number, id: number): Promise<void> {
    const current = await this.#owned(userId, id);
    await this.#db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({ categoryId: current.parentId })
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.categoryId, id)));
      await tx
        .update(categories)
        .set({ parentId: current.parentId })
        .where(and(eq(categories.userId, userId), eq(categories.parentId, id)));
      await tx.delete(categories).where(eq(categories.id, id));
    });
  }

  /** Returns the category if the user owns it; otherwise throws not_found. */
  async #owned(userId: number, id: number): Promise<CategoryRow> {
    const [row] = await this.#db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, userId)));
    if (!row) throw new DomainError('not_found', 'Category not found');
    return row;
  }

  async #assertNotDescendant(userId: number, id: number, newParentId: number): Promise<void> {
    const all = await this.list(userId);
    const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
    if (!parentOf.has(newParentId)) throw new DomainError('not_found', 'Parent category not found');
    for (
      let node: number | null | undefined = newParentId;
      node != null;
      node = parentOf.get(node)
    ) {
      if (node === id)
        throw new DomainError('invalid_input', 'A category cannot be moved into itself');
    }
  }

  async #unique<T>(title: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('conflict', `A category named "${title}" already exists there`);
      }
      throw err;
    }
  }
}
