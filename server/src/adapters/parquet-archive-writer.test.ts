import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArchiveRow } from '../core/ports.ts';
import { LocalBlobStore } from './local-blob-store.ts';
import { ParquetArchiveWriter } from './parquet-archive-writer.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const row = (overrides: Partial<ArchiveRow>): ArchiveRow => ({
  id: null,
  feedUrl: 'https://a.example/feed',
  feedTitle: 'A',
  guid: 'g',
  link: null,
  title: null,
  author: null,
  content: null,
  text: null,
  lang: null,
  publishedAt: null,
  sourceUpdatedAt: null,
  fetchedAt: new Date('2024-05-01T00:00:00Z'),
  sortAt: new Date('2024-05-01T00:00:00Z'),
  archivedAt: new Date('2026-10-11T12:00:00.123Z'),
  enclosures: [],
  ...overrides,
});

async function query(sql: string) {
  const connection = await (await DuckDBInstance.create()).connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJson();
  } finally {
    connection.closeSync();
  }
}

const files = () => `'${root}/archive/entries/*/*.parquet'`;

describe('ParquetArchiveWriter', () => {
  it('writes one file per month of sort time, in month partitions', async () => {
    const writer = new ParquetArchiveWriter(new LocalBlobStore(root));
    await writer.write([
      row({ guid: 'may-1', sortAt: new Date('2024-05-01T00:00:00Z') }),
      row({ guid: 'may-31', sortAt: new Date('2024-05-31T23:59:59Z') }),
      row({ guid: 'june', sortAt: new Date('2024-06-01T00:00:00Z') }),
    ]);
    await writer.write([row({ guid: 'may-again' })]);

    const months = await readdir(join(root, 'archive/entries'));
    expect(months.sort()).toEqual(['month=2024-05', 'month=2024-06']);
    expect(await readdir(join(root, 'archive/entries/month=2024-05'))).toHaveLength(2);
    expect(
      await query(
        `SELECT month, count(*)::INT AS n FROM read_parquet(${files()}, hive_partitioning = true)
         GROUP BY month ORDER BY month`,
      ),
    ).toEqual([
      { month: '2024-05', n: 3 },
      { month: '2024-06', n: 1 },
    ]);
  });

  it('round-trips every column, sorted by feed and time', async () => {
    const writer = new ParquetArchiveWriter(new LocalBlobStore(root));
    await writer.write([
      row({
        id: 9_007_199_254_740_000,
        feedUrl: 'https://b.example/feed',
        feedTitle: 'B',
        guid: 'b1',
        link: 'https://b.example/1',
        title: 'Ünïcode title',
        author: 'Ann',
        content: '<p>Hi</p>',
        text: 'Hi',
        lang: 'en',
        publishedAt: new Date('2024-05-02T03:04:05.678Z'),
        sourceUpdatedAt: new Date('2024-05-03T00:00:00Z'),
        fetchedAt: new Date('2024-05-02T04:00:00Z'),
        sortAt: new Date('2024-05-02T03:04:05.678Z'),
        enclosures: [
          {
            url: 'https://b.example/1.mp3',
            mimeType: 'audio/mpeg',
            length: 12_345_678_901,
            width: null,
            height: null,
            durationSeconds: 61,
          },
        ],
      }),
      row({ guid: 'a2', sortAt: new Date('2024-05-09T00:00:00Z') }),
      row({ guid: 'a1', sortAt: new Date('2024-05-08T00:00:00Z') }),
    ]);

    const rows = await query(
      `SELECT * EXCLUDE (month), strftime(sort_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') AS sort,
         strftime(archived_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') AS archived
       FROM read_parquet(${files()}, hive_partitioning = true)`,
    );
    expect(rows.map((r) => r.guid)).toEqual(['a1', 'a2', 'b1']);
    expect(rows[2]).toMatchObject({
      id: '9007199254740000',
      feed_url: 'https://b.example/feed',
      feed_title: 'B',
      link: 'https://b.example/1',
      title: 'Ünïcode title',
      author: 'Ann',
      content: '<p>Hi</p>',
      text: 'Hi',
      lang: 'en',
      sort: '2024-05-02T03:04:05.678',
      archived: '2026-10-11T12:00:00.123',
      enclosures: [
        {
          url: 'https://b.example/1.mp3',
          mime_type: 'audio/mpeg',
          length: '12345678901',
          width: null,
          height: null,
          duration_seconds: 61,
        },
      ],
    });
    expect(rows[0]).toMatchObject({ id: null, published_at: null, enclosures: [] });
  });
});
