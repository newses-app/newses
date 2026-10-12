import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { DuckDBInstance } from '@duckdb/node-api';
import type { ArchiveListQuery, ArchiveReader, ArchiveRow, BlobStore } from '../core/ports.ts';
import { ARCHIVE_CONTENT_TYPE, ARCHIVE_PARTITION, ARCHIVE_PREFIX } from './archive-format.ts';
import {
  type ArchiveDialect,
  compactedSql,
  getStatement,
  listStatement,
  literal,
  type Param,
  parseRow,
} from './archive-sql.ts';

/** The month folder of an archive file's path. */
const MONTH = new RegExp(`/${ARCHIVE_PARTITION}=(\\d{4}-\\d{2})/[^/]+$`);

/**
 * Reads the archive in a local blob directory with DuckDB, in-process. DuckDB loads on first use,
 * so processes that never read the archive (and bundles without DuckDB) do not need it.
 */
export class DuckDbArchiveReader implements ArchiveReader {
  readonly #root: string;
  readonly #blobs: BlobStore;
  readonly #pattern: string;
  readonly #dialect: ArchiveDialect;
  #instance: Promise<DuckDBInstance> | null = null;

  /** `blobs` stores files in `blobDir`, as `LocalBlobStore` does. */
  constructor(blobDir: string, blobs: BlobStore) {
    this.#root = resolve(blobDir);
    this.#blobs = blobs;
    this.#pattern = join(this.#root, ARCHIVE_PREFIX, `${ARCHIVE_PARTITION}=*`, '*.parquet');
    this.#dialect = {
      table: `read_parquet(${literal(this.#pattern)}, hive_partitioning = true,
        hive_types = {'${ARCHIVE_PARTITION}': VARCHAR}, union_by_name = true)`,
      ms: (column) => `epoch_ms(${column})`,
      json: (column) => `CAST(to_json(${column}) AS VARCHAR)`,
    };
  }

  async list(query: ArchiveListQuery): Promise<ArchiveRow[]> {
    if (query.feedUrls.length === 0 || (await this.#files()).length === 0) return [];
    const { sql, params } = listStatement(this.#dialect, query);
    return (await this.#query(sql, params)).map(parseRow);
  }

  async get(month: string, feedUrl: string, guid: string): Promise<ArchiveRow | null> {
    if ((await this.#files()).length === 0) return null;
    const { sql, params } = getStatement(this.#dialect, month, feedUrl, guid);
    const [row] = await this.#query(sql, params);
    return row ? parseRow(row) : null;
  }

  async compact(deadline: number): Promise<number> {
    const current = new Date().toISOString().slice(0, 7);
    const months = Map.groupBy(await this.#files(), (file) => MONTH.exec(file)?.[1] ?? '');
    let merged = 0;
    for (const [month, files] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      if (Date.now() >= deadline) break;
      if (!month || month >= current || files.length < 2) continue;
      const temp = join(tmpdir(), `archive-${randomUUID()}.parquet`);
      try {
        const table = `read_parquet([${files.map(literal).join(', ')}], union_by_name = true)`;
        await this.#query(
          `COPY (${compactedSql(table)}) TO ${literal(temp)} (FORMAT parquet, COMPRESSION zstd)`,
        );
        await this.#blobs.put(
          `${ARCHIVE_PREFIX}/${ARCHIVE_PARTITION}=${month}/${randomUUID()}.parquet`,
          { data: new Uint8Array(await readFile(temp)), contentType: ARCHIVE_CONTENT_TYPE },
        );
      } finally {
        await rm(temp, { force: true });
      }
      for (const file of files) await this.#blobs.delete(relative(this.#root, file));
      merged++;
    }
    return merged;
  }

  /** Paths of every archive file. */
  async #files(): Promise<string[]> {
    const rows = await this.#query('SELECT file FROM glob(?) ORDER BY file', [this.#pattern]);
    return rows.map((row) => String(row.file));
  }

  async #query(sql: string, params: Param[] = []): Promise<Record<string, unknown>[]> {
    this.#instance ??= import('@duckdb/node-api').then(({ DuckDBInstance }) =>
      DuckDBInstance.create(':memory:'),
    );
    const connection = await (await this.#instance).connect();
    try {
      return (await connection.runAndReadAll(sql, params)).getRowObjectsJson();
    } finally {
      connection.closeSync();
    }
  }
}
