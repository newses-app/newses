import { randomUUID } from 'node:crypto';
import {
  type AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ArchiveListQuery, ArchiveReader, ArchiveRow } from '../core/ports.ts';
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

/** Runs Athena queries; values come back as text. */
export interface AthenaRunner {
  query(sql: string, params?: Param[]): Promise<Record<string, string | null>[]>;
  /** Runs a statement that returns no rows, such as UNLOAD. */
  execute(sql: string): Promise<void>;
}

/** Athena substitutes execution parameters as written, so strings arrive quoted. */
export const renderParam = (param: Param) =>
  typeof param === 'number' ? String(param) : literal(param);

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs queries in an Athena workgroup, whose settings say where results go. */
export class AthenaClientRunner implements AthenaRunner {
  readonly #client: AthenaClient;
  readonly #workgroup: string;
  readonly #database: string;

  constructor(client: AthenaClient, options: { workgroup: string; database: string }) {
    this.#client = client;
    this.#workgroup = options.workgroup;
    this.#database = options.database;
  }

  async query(sql: string, params: Param[] = []): Promise<Record<string, string | null>[]> {
    const id = await this.#run(sql, params);
    const rows: Record<string, string | null>[] = [];
    let token: string | undefined;
    let header = true;
    do {
      const page = await this.#client.send(
        new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token, MaxResults: 1000 }),
      );
      const names = (page.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map((c) => c.Name ?? '');
      for (const row of page.ResultSet?.Rows ?? []) {
        // The first row of a query's results repeats the column names.
        if (header) {
          header = false;
          continue;
        }
        rows.push(
          Object.fromEntries(names.map((name, i) => [name, row.Data?.[i]?.VarCharValue ?? null])),
        );
      }
      token = page.NextToken;
    } while (token);
    return rows;
  }

  async execute(sql: string): Promise<void> {
    await this.#run(sql, []);
  }

  /** Starts a query and waits for it to succeed; returns its id. */
  async #run(sql: string, params: Param[]): Promise<string> {
    const { QueryExecutionId: id } = await this.#client.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: this.#workgroup,
        QueryExecutionContext: { Database: this.#database },
        ...(params.length > 0 && { ExecutionParameters: params.map(renderParam) }),
      }),
    );
    if (!id) throw new Error('Athena returned no query id');
    for (let delay = 100; ; delay = Math.min(delay * 1.5, 1000)) {
      await sleep(delay);
      const { QueryExecution: execution } = await this.#client.send(
        new GetQueryExecutionCommand({ QueryExecutionId: id }),
      );
      const state = execution?.Status?.State;
      if (state === 'SUCCEEDED') return id;
      if (state === 'FAILED' || state === 'CANCELLED')
        throw new Error(
          `Athena query ${state.toLowerCase()}: ${execution?.Status?.StateChangeReason ?? ''}`,
        );
    }
  }
}

const MONTH = /^\d{4}-\d{2}$/;

/**
 * Reads the archive in the blob bucket through Athena, over the Glue table that catalogues it.
 * Compaction has Athena write each month afresh to a staging prefix, then moves the result into
 * the month's folder and deletes the files it replaced.
 */
export class AthenaArchiveReader implements ArchiveReader {
  readonly #runner: AthenaRunner;
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #table: string;
  readonly #dialect: ArchiveDialect;

  constructor(runner: AthenaRunner, options: { s3: S3Client; bucket: string; table: string }) {
    this.#runner = runner;
    this.#s3 = options.s3;
    this.#bucket = options.bucket;
    this.#table = options.table;
    this.#dialect = {
      table: options.table,
      ms: (column) => `CAST(round(to_unixtime(${column}) * 1000) AS BIGINT)`,
      json: (column) => `json_format(CAST(${column} AS JSON))`,
    };
  }

  async list(query: ArchiveListQuery): Promise<ArchiveRow[]> {
    if (query.feedUrls.length === 0) return [];
    const { sql, params } = listStatement(this.#dialect, query);
    return (await this.#runner.query(sql, params)).map(parseRow);
  }

  async get(month: string, feedUrl: string, guid: string): Promise<ArchiveRow | null> {
    const { sql, params } = getStatement(this.#dialect, month, feedUrl, guid);
    const [row] = await this.#runner.query(sql, params);
    return row ? parseRow(row) : null;
  }

  async compact(deadline: number): Promise<number> {
    const current = new Date().toISOString().slice(0, 7);
    const files = await this.#runner.query(
      `SELECT DISTINCT ${ARCHIVE_PARTITION} AS month, "$path" AS path FROM ${this.#table}`,
    );
    const months = Map.groupBy(files, (f) => f.month ?? '');
    let merged = 0;
    for (const [month, monthFiles] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      if (Date.now() >= deadline) break;
      if (!MONTH.test(month) || month >= current || monthFiles.length < 2) continue;
      const staging = `archive/staging/${randomUUID()}/`;
      await this.#runner.execute(
        `UNLOAD (${compactedSql(this.#table, `${ARCHIVE_PARTITION} = ${literal(month)}`)})
        TO ${literal(`s3://${this.#bucket}/${staging}`)}
        WITH (format = 'PARQUET', compression = 'SNAPPY')`,
      );
      for (const key of await this.#keys(staging)) {
        await this.#s3.send(
          new CopyObjectCommand({
            Bucket: this.#bucket,
            CopySource: `${this.#bucket}/${key}`,
            Key: `${ARCHIVE_PREFIX}/${ARCHIVE_PARTITION}=${month}/${randomUUID()}.parquet`,
            ContentType: ARCHIVE_CONTENT_TYPE,
            MetadataDirective: 'REPLACE',
          }),
        );
        await this.#delete(key);
      }
      const prefix = `s3://${this.#bucket}/`;
      for (const { path } of monthFiles)
        if (path?.startsWith(prefix)) await this.#delete(path.slice(prefix.length));
      merged++;
    }
    return merged;
  }

  async #keys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = page.NextContinuationToken;
    } while (token);
    return keys;
  }

  async #delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
