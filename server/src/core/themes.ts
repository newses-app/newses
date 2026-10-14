import {
  MAX_THEMES_PER_USER,
  type CreateThemeRequest,
  type UpdateThemeRequest,
} from '@newses/shared';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { themes, users } from '../db/schema.ts';
import { isUniqueViolation } from './db-errors.ts';
import { DomainError } from './errors.ts';

export type ThemeRow = typeof themes.$inferSelect;

/** A theme with its author's login. */
export interface ThemeView {
  theme: ThemeRow;
  ownerLogin: string;
}

/** Users' named appearance themes; each user sees their own and others' shared ones. */
export class ThemeService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The user's themes and those others share, by name. */
  async list(userId: number): Promise<ThemeView[]> {
    return this.#select().where(or(eq(themes.ownerId, userId), eq(themes.shared, true)));
  }

  async create(userId: number, theme: CreateThemeRequest): Promise<ThemeView> {
    const [existing] = await this.#db
      .select({ n: count() })
      .from(themes)
      .where(eq(themes.ownerId, userId));
    if ((existing?.n ?? 0) >= MAX_THEMES_PER_USER) {
      throw new DomainError('invalid_input', `At most ${String(MAX_THEMES_PER_USER)} themes`);
    }
    const row = await this.#unique(theme.name, async () => {
      const [inserted] = await this.#db
        .insert(themes)
        .values({ ownerId: userId, ...theme })
        .returning();
      if (!inserted) throw new Error('Theme insert returned no row');
      return inserted;
    });
    return this.#view(row.id);
  }

  /** Changes one of the user's own themes. */
  async update(userId: number, id: number, changes: UpdateThemeRequest): Promise<ThemeView> {
    const owned = and(eq(themes.id, id), eq(themes.ownerId, userId));
    const [row] = await this.#unique(changes.name ?? '', () =>
      Object.keys(changes).length > 0
        ? this.#db.update(themes).set(changes).where(owned).returning({ id: themes.id })
        : this.#db.select({ id: themes.id }).from(themes).where(owned),
    );
    if (!row) throw new DomainError('not_found', 'Theme not found');
    return this.#view(row.id);
  }

  /** Deletes one of the user's own themes; its users fall back to Original. */
  async delete(userId: number, id: number): Promise<void> {
    const deleted = await this.#db
      .delete(themes)
      .where(and(eq(themes.id, id), eq(themes.ownerId, userId)))
      .returning({ id: themes.id });
    if (deleted.length === 0) throw new DomainError('not_found', 'Theme not found');
  }

  #select() {
    return this.#db
      .select({ theme: themes, ownerLogin: users.login })
      .from(themes)
      .innerJoin(users, eq(users.id, themes.ownerId))
      .orderBy(asc(sql`lower(${themes.name})`), asc(themes.id))
      .$dynamic();
  }

  async #view(id: number): Promise<ThemeView> {
    const [view] = await this.#select().where(eq(themes.id, id));
    if (!view) throw new DomainError('not_found', 'Theme not found');
    return view;
  }

  async #unique<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err))
        throw new DomainError('conflict', `A theme named "${name}" already exists`);
      throw err;
    }
  }
}
