import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from './local-blob-store.ts';

let root: string;
let store: LocalBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blobs-'));
  store = new LocalBlobStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const blob = (text: string, contentType = 'text/plain') => ({
  data: new TextEncoder().encode(text),
  contentType,
});

describe('LocalBlobStore', () => {
  it('round-trips data and content type', async () => {
    await store.put('favicons/1.png', blob('png-bytes', 'image/png'));
    const got = await store.get('favicons/1.png');
    expect(got?.contentType).toBe('image/png');
    expect(new TextDecoder().decode(got?.data)).toBe('png-bytes');
  });

  it('overwrites existing blobs', async () => {
    await store.put('a', blob('one'));
    await store.put('a', blob('two', 'text/html'));
    const got = await store.get('a');
    expect(new TextDecoder().decode(got?.data)).toBe('two');
    expect(got?.contentType).toBe('text/html');
  });

  it('returns null for missing and deleted blobs', async () => {
    expect(await store.get('missing')).toBeNull();
    await store.put('gone', blob('x'));
    await store.delete('gone');
    expect(await store.get('gone')).toBeNull();
    await store.delete('never-existed');
  });

  it.each(['', '../escape', 'a/../b', '.meta/a', 'a//b', '/abs', 'a/'])(
    'rejects key %j',
    async (key) => {
      await expect(store.put(key, blob('x'))).rejects.toThrow(/Invalid blob key/);
    },
  );
});
