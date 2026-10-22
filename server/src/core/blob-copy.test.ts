import { describe, expect, it } from 'vitest';
import { MemoryBlobStore } from '../test/fakes.ts';
import { copyBlobs } from './blob-copy.ts';

const blob = (text: string, contentType: string) => ({
  data: new TextEncoder().encode(text),
  contentType,
});

describe('copyBlobs', () => {
  it('copies the blobs under a prefix, keeping content types', async () => {
    const source = new MemoryBlobStore();
    for (let i = 0; i < 40; i++) await source.put(`images/${String(i)}`, blob('img', 'image/png'));
    await source.put(
      'archive/entries/month=2024-05/a.parquet',
      blob('pq', 'application/x-parquet'),
    );

    const archive = new MemoryBlobStore();
    expect(await copyBlobs(source, archive, 'archive/')).toEqual({ count: 1, bytes: 2 });
    expect([...archive.blobs.keys()]).toEqual(['archive/entries/month=2024-05/a.parquet']);

    const target = new MemoryBlobStore();
    const progress: number[] = [];
    expect(await copyBlobs(source, target, '', ({ count }) => progress.push(count))).toEqual({
      count: 41,
      bytes: 122,
    });
    expect(progress.at(-1)).toBe(41);
    expect(target.blobs.get('images/7')).toEqual(blob('img', 'image/png'));
  });

  it('skips blobs deleted while listed', async () => {
    const source = new MemoryBlobStore();
    await source.put('a', blob('x', 'text/plain'));
    const vanishing = Object.assign(Object.create(source) as MemoryBlobStore, {
      get: () => Promise.resolve(null),
    });
    expect(await copyBlobs(vanishing, new MemoryBlobStore())).toEqual({ count: 0, bytes: 0 });
  });
});
