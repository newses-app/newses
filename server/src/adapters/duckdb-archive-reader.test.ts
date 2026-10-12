import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveRow, describeArchiveReader } from '../test/archive-reader-contract.ts';
import { DuckDbArchiveReader } from './duckdb-archive-reader.ts';
import { LocalBlobStore } from './local-blob-store.ts';
import { ParquetArchiveWriter } from './parquet-archive-writer.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = () => {
  const blobs = new LocalBlobStore(root);
  return { reader: new DuckDbArchiveReader(root, blobs), writer: new ParquetArchiveWriter(blobs) };
};

describeArchiveReader('DuckDbArchiveReader', setup);

describe('DuckDbArchiveReader compaction', () => {
  const files = async (month: string) =>
    (await readdir(join(root, 'archive/entries', `month=${month}`))).sort();

  it('merges each finished month with several files into one, keeping the latest copies', async () => {
    const { reader, writer } = setup();
    const thisMonth = new Date();
    await writer.write([archiveRow({ guid: 'old', title: 'v1' })]);
    await writer.write([archiveRow({ guid: 'old', title: 'v2', archivedAt: new Date() })]);
    await writer.write([archiveRow({ guid: 'other' })]);
    await writer.write([archiveRow({ guid: 'now-1', sortAt: thisMonth })]);
    await writer.write([archiveRow({ guid: 'now-2', sortAt: thisMonth })]);
    const current = thisMonth.toISOString().slice(0, 7);
    expect(await files('2024-05')).toHaveLength(3);

    expect(await reader.compact(Date.now() + 60_000)).toBe(1);
    expect(await files('2024-05')).toHaveLength(1);
    expect(await files(current)).toHaveLength(2);
    // The metadata of the deleted files went with them.
    expect(await readdir(join(root, '.meta/archive/entries/month=2024-05'))).toHaveLength(1);
    const query = { feedUrls: ['https://a.example/feed'], terms: [], after: null, limit: 10 };
    const rows = await reader.list(query);
    expect(rows.map((r) => [r.guid, r.title])).toEqual([
      ['now-2', null],
      ['now-1', null],
      ['other', null],
      ['old', 'v2'],
    ]);
    expect(await reader.get('2024-05', 'https://a.example/feed', 'old')).toMatchObject({
      title: 'v2',
    });
    expect(await reader.compact(Date.now() + 60_000)).toBe(0);
  });

  it('stops at the deadline', async () => {
    const { reader, writer } = setup();
    await writer.write([archiveRow({ guid: 'a' })]);
    await writer.write([archiveRow({ guid: 'b' })]);
    expect(await reader.compact(Date.now() - 1)).toBe(0);
    expect(await files('2024-05')).toHaveLength(2);
  });
});
