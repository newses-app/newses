import { describe, expect, it } from 'vitest';
import type { BlobStore } from '../core/ports.ts';

const blob = (text: string, contentType = 'text/plain') => ({
  data: new TextEncoder().encode(text),
  contentType,
});

/** Behaviour every BlobStore adapter shares; `store` is read when each test runs. */
export function describeBlobStore(name: string, store: () => BlobStore) {
  describe(name, () => {
    it('round-trips data and content type', async () => {
      await store().put('favicons/1.png', blob('png-bytes', 'image/png'));
      const got = await store().get('favicons/1.png');
      expect(got?.contentType).toBe('image/png');
      expect(new TextDecoder().decode(got?.data)).toBe('png-bytes');
    });

    it('overwrites existing blobs', async () => {
      await store().put('a', blob('one'));
      await store().put('a', blob('two', 'text/html'));
      const got = await store().get('a');
      expect(new TextDecoder().decode(got?.data)).toBe('two');
      expect(got?.contentType).toBe('text/html');
    });

    it('returns null for missing and deleted blobs', async () => {
      expect(await store().get('missing')).toBeNull();
      await store().put('gone', blob('x'));
      await store().delete('gone');
      expect(await store().get('gone')).toBeNull();
      await store().delete('never-existed');
    });

    it('accepts partition-style segments', async () => {
      await store().put('archive/month=2024-05/a.parquet', blob('x'));
      expect(await store().get('archive/month=2024-05/a.parquet')).not.toBeNull();
    });

    it.each(['', '../escape', 'a/../b', '.meta/a', 'a//b', '/abs', 'a/', '=a'])(
      'rejects key %j',
      async (key) => {
        await expect(store().put(key, blob('x'))).rejects.toThrow(/Invalid blob key/);
      },
    );
  });
}
