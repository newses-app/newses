import pg from 'pg';
import { ImportError } from './errors.ts';

/** Rows read per query when walking a source table. */
export const SOURCE_BATCH = 1000;

/**
 * A TTRSS database, read in one read-only REPEATABLE READ transaction, so every query sees the
 * same snapshot and nothing can be written to the source.
 */
export class TtrssSource {
  readonly #client: pg.Client;

  private constructor(client: pg.Client) {
    this.#client = client;
  }

  static async open(url: string): Promise<TtrssSource> {
    const client = new pg.Client({ connectionString: url, application_name: 'rss-reader import' });
    try {
      await client.connect();
    } catch (err) {
      throw new ImportError(
        `Cannot connect to the source database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // The snapshot is taken by the first query, so take it now.
      await client.query('SELECT 1');
    } catch (err) {
      await client.end();
      throw err;
    }
    return new TtrssSource(client);
  }

  async query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.#client.query<T>(text, values)).rows;
  }

  /** `ttrss_version.schema_version`; null when the table is missing or empty. */
  async schemaVersion(): Promise<number | null> {
    const [table] = await this.query<{ name: string | null }>(
      "SELECT to_regclass('ttrss_version')::text AS name",
    );
    if (!table?.name) return null;
    const [row] = await this.query<{ schema_version: number }>(
      'SELECT schema_version FROM ttrss_version LIMIT 1',
    );
    return row?.schema_version ?? null;
  }

  /**
   * Walks a query in id order, `size` rows at a time. `build` returns SQL that selects rows whose
   * id is greater than its `after` placeholder, ordered by id, limited by its `limit` placeholder.
   */
  async *batches<T extends pg.QueryResultRow & { id: number }>(
    build: (after: string, limit: string) => string,
    values: unknown[] = [],
    size = SOURCE_BATCH,
  ): AsyncGenerator<T[]> {
    const text = build(`$${String(values.length + 1)}`, `$${String(values.length + 2)}`);
    // The smallest integer, so the first batch starts at any id an integer column holds.
    for (let after = -2_147_483_648; ;) {
      const rows = await this.query<T>(text, [...values, after, size]);
      if (rows.length === 0) return;
      yield rows;
      after = Number(rows.at(-1)?.id);
      if (rows.length < size) return;
    }
  }

  async close(): Promise<void> {
    try {
      await this.#client.query('ROLLBACK');
    } finally {
      await this.#client.end();
    }
  }
}
