import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importMap } from '../db/schema.ts';

/** A connection or transaction the importer writes through. */
export type Writer = Pick<Db, 'execute' | 'insert' | 'update' | 'select' | 'delete'>;

export interface MappedRow {
  sourceId: number;
  targetId: number;
  userId: number | null;
}

export interface ImportedUser {
  sourceId: number;
  userId: number;
  /** When the user's last import finished; null while it never has. */
  completedAt: Date | null;
}

/** Which source rows were imported, and as what. */
export class ImportMap {
  readonly #db: Writer;

  constructor(db: Writer) {
    this.#db = db;
  }

  /** Target ids of the given source rows that were imported. */
  async targets(
    sourceTable: string,
    sourceIds: number[],
    db: Writer = this.#db,
  ): Promise<Map<number, number>> {
    if (sourceIds.length === 0) return new Map();
    const rows = await db
      .select({ sourceId: importMap.sourceId, targetId: importMap.targetId })
      .from(importMap)
      .where(and(eq(importMap.sourceTable, sourceTable), inArray(importMap.sourceId, sourceIds)));
    return new Map(rows.map((row) => [row.sourceId, row.targetId]));
  }

  /** Records imported rows; a row imported before is pointed at its new target. */
  async record(db: Writer, sourceTable: string, rows: MappedRow[]): Promise<void> {
    if (rows.length === 0) return;
    await db
      .insert(importMap)
      .values(rows.map((row) => ({ sourceTable, ...row })))
      .onConflictDoUpdate({
        target: [importMap.sourceTable, importMap.sourceId],
        set: {
          targetId: sql`excluded.target_id`,
          userId: sql`excluded.user_id`,
          importedAt: sql`now()`,
        },
      });
  }

  /** The given TTRSS users that were imported, with when their last import finished. */
  async users(sourceIds: number[]): Promise<ImportedUser[]> {
    if (sourceIds.length === 0) return [];
    const rows = await this.#db
      .select({
        sourceId: importMap.sourceId,
        userId: importMap.targetId,
        completedAt: importMap.completedAt,
      })
      .from(importMap)
      .where(and(eq(importMap.sourceTable, USERS), inArray(importMap.sourceId, sourceIds)));
    return rows;
  }

  /**
   * Marks a run of the TTRSS users' imports started now. While earlier runs are unfinished, their
   * start is kept, so the window covers every unfinished run; the end is cleared until `end`.
   */
  async start(sourceIds: number[]): Promise<void> {
    await this.#setOnUsers(sourceIds, {
      runStartedAt: sql`CASE WHEN ${importMap.runStartedAt} > coalesce(${importMap.completedAt}, '-infinity')
        THEN ${importMap.runStartedAt} ELSE now() END`,
      runEndedAt: null,
    });
  }

  /** Marks the TTRSS users' current run ended now, finished or not. */
  async end(sourceIds: number[]): Promise<void> {
    await this.#setOnUsers(sourceIds, { runEndedAt: sql`now()` });
  }

  /** Marks the TTRSS users' imports finished now. */
  async complete(sourceIds: number[]): Promise<void> {
    await this.#setOnUsers(sourceIds, { completedAt: sql`now()` });
  }

  async #setOnUsers(
    sourceIds: number[],
    values: Partial<Record<'completedAt' | 'runStartedAt' | 'runEndedAt', SQL | null>>,
  ): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.#db
      .update(importMap)
      .set(values)
      .where(and(eq(importMap.sourceTable, USERS), inArray(importMap.sourceId, sourceIds)));
  }
}

/** Source table of user rows, whose map rows also record finished imports. */
export const USERS = 'ttrss_users';
