import type { ArchivedEntry } from '@newses/shared';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { withSetup } from '../test/mount.ts';
import { spyInvalidations } from '../test/queries.ts';
import { useArchivedEntry, useArchiveList, useRestore } from './useArchive.ts';

const api = vi.hoisted(() => ({
  archive: {
    list: vi.fn((query: { cursor?: string }) =>
      Promise.resolve(
        query.cursor
          ? { entries: [{ key: 'b' }], cursor: null }
          : { entries: [{ key: 'a' }], cursor: 'next' },
      ),
    ),
    get: vi.fn((key: string) => Promise.resolve({ key, content: '<p>x</p>' })),
    restore: vi.fn(() => Promise.resolve({ id: 9 })),
  },
}));
vi.mock('../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

describe('useArchiveList', () => {
  it('loads pages for all feeds, then the next one by its cursor', async () => {
    const { result } = withSetup(() => useArchiveList({ subscriptionId: null, q: null }));
    await flushPromises();
    expect(api.archive.list).toHaveBeenLastCalledWith({ limit: 50 });
    expect(result.entries.value).toEqual([{ key: 'a' }]);
    expect(result.hasNextPage.value).toBe(true);

    await result.fetchNextPage();
    expect(api.archive.list).toHaveBeenLastCalledWith({ cursor: 'next', limit: 50 });
    expect(result.entries.value).toEqual([{ key: 'a' }, { key: 'b' }]);
    expect(result.hasNextPage.value).toBe(false);
  });

  it('narrows to one feed, and searches in the time zone here', async () => {
    withSetup(() => useArchiveList({ subscriptionId: 4, q: 'cats' }));
    await flushPromises();
    expect(api.archive.list).toHaveBeenLastCalledWith({
      subscriptionId: 4,
      q: 'cats',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      limit: 50,
    });
  });
});

describe('useArchivedEntry', () => {
  it('loads an article once there is a key', async () => {
    const key = ref<string | null>(null);
    const { result } = withSetup(() => useArchivedEntry(key));
    await flushPromises();
    expect(api.archive.get).not.toHaveBeenCalled();
    key.value = 'a';
    await nextTick();
    await flushPromises();
    expect(result.data.value).toEqual({ key: 'a', content: '<p>x</p>' });
  });
});

describe('useRestore', () => {
  it('restores an article, then refetches the archive, entries, and counters', async () => {
    const { result: restore, queryClient } = withSetup(() => useRestore());
    const invalidate = spyInvalidations(queryClient);
    const entry = { key: 'a' } as ArchivedEntry;
    await expect(restore(entry, { starred: true })).resolves.toEqual({ id: 9 });
    expect(api.archive.restore).toHaveBeenCalledWith('a', { starred: true });
    expect(invalidate.keys()).toEqual([['archive'], ['entries'], ['counters']]);
  });
});
