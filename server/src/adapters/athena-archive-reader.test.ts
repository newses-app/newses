import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeArchiveReader } from '../test/archive-reader-contract.ts';
import { AthenaArchiveReader, type AthenaRunner, renderParam } from './athena-archive-reader.ts';
import { literal, type Param } from './archive-sql.ts';
import { LocalBlobStore } from './local-blob-store.ts';
import { ParquetArchiveWriter } from './parquet-archive-writer.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Runs Athena's SQL in DuckDB over the local archive: parameters are substituted as Athena does,
 * the Glue table is a view, and macros stand in for the Trino functions DuckDB lacks.
 */
class DuckDbAthena implements AthenaRunner {
  async query(sql: string, params: Param[] = []): Promise<Record<string, string | null>[]> {
    const pattern = join(root, 'archive/entries/month=*/*.parquet');
    const connection = await (await DuckDBInstance.create(':memory:')).connect();
    try {
      const files = (
        await connection.runAndReadAll('SELECT file FROM glob(?)', [pattern])
      ).getRows();
      if (files.length === 0) return [];
      await connection.run(`
        CREATE MACRO to_unixtime(t) AS epoch_ms(t) / 1000.0;
        CREATE MACRO json_format(j) AS CAST(j AS VARCHAR);
        CREATE VIEW archive_entries AS SELECT * FROM read_parquet(${literal(pattern)},
          hive_partitioning = true, hive_types = {'month': VARCHAR}, union_by_name = true);`);
      const parts = sql.split('?');
      const text = parts.reduce((all, part, i) => all + renderParam(params[i - 1] ?? '') + part);
      const rows = (await connection.runAndReadAll(text)).getRowObjectsJson();
      // Athena returns every value as text.
      const asText = (v: unknown) =>
        v === null ? null : typeof v === 'string' ? v : JSON.stringify(v);
      return rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, asText(v)])),
      );
    } finally {
      connection.closeSync();
    }
  }

  execute(): Promise<void> {
    return Promise.reject(new Error('not supported'));
  }
}

describeArchiveReader('AthenaArchiveReader', () => ({
  reader: new AthenaArchiveReader(new DuckDbAthena(), {
    s3: {} as S3Client,
    bucket: 'blobs',
    table: 'archive_entries',
  }),
  writer: new ParquetArchiveWriter(new LocalBlobStore(root)),
}));

describe('AthenaArchiveReader compaction', () => {
  it('rewrites each finished month with several files through a staging prefix', async () => {
    const current = new Date().toISOString().slice(0, 7);
    const file = (month: string, name: string) => ({
      month,
      path: `s3://blobs/archive/entries/month=${month}/${name}.parquet`,
    });
    const statements: string[] = [];
    const runner: AthenaRunner = {
      query: () =>
        Promise.resolve([
          file('2024-05', 'a'),
          file('2024-05', 'b'),
          file('2024-06', 'c'),
          file(current, 'd'),
          file(current, 'e'),
        ]),
      execute: (sql) => {
        statements.push(sql);
        return Promise.resolve();
      },
    };
    const sent: { op: string; key: string | undefined; from?: string | undefined }[] = [];
    const s3 = {
      send: (command: unknown) => {
        if (command instanceof ListObjectsV2Command)
          return Promise.resolve({ Contents: [{ Key: `${command.input.Prefix ?? ''}part-0` }] });
        if (command instanceof CopyObjectCommand)
          sent.push({ op: 'copy', key: command.input.Key, from: command.input.CopySource });
        if (command instanceof DeleteObjectCommand)
          sent.push({ op: 'delete', key: command.input.Key });
        return Promise.resolve({});
      },
    } as unknown as S3Client;
    const reader = new AthenaArchiveReader(runner, {
      s3,
      bucket: 'blobs',
      table: 'archive_entries',
    });

    expect(await reader.compact(Date.now() + 60_000)).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UNLOAD \(SELECT id, feed_url,/);
    expect(statements[0]).toContain("WHERE month = '2024-05'");
    expect(statements[0]).toMatch(/TO 's3:\/\/blobs\/archive\/staging\/[0-9a-f-]+\/'/);
    const staged = /archive\/staging\/[0-9a-f-]+\/part-0/;
    expect(sent).toEqual([
      {
        op: 'copy',
        from: expect.stringMatching(new RegExp(`^blobs/${staged.source}$`)) as string,
        key: expect.stringMatching(
          /^archive\/entries\/month=2024-05\/[0-9a-f-]+\.parquet$/,
        ) as string,
      },
      { op: 'delete', key: expect.stringMatching(staged) as string },
      { op: 'delete', key: 'archive/entries/month=2024-05/a.parquet' },
      { op: 'delete', key: 'archive/entries/month=2024-05/b.parquet' },
    ]);
  });
});
