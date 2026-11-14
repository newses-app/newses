import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { withSetup } from '../test/mount.ts';
import { spyInvalidations } from '../test/queries.ts';
import {
  CATEGORIES_KEY,
  SUBSCRIPTIONS_KEY,
  useCategories,
  useFeedsRefresh,
  useSubscriptions,
} from './useFeeds.ts';

const api = vi.hoisted(() => ({
  subscriptions: { list: vi.fn(() => Promise.resolve([{ id: 1 }])) },
  categories: { list: vi.fn(() => Promise.resolve([{ id: 2 }])) },
}));
vi.mock('../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

describe('useFeeds', () => {
  it("loads the user's subscriptions and categories", async () => {
    const { result } = withSetup(() => ({
      subscriptions: useSubscriptions(),
      categories: useCategories(),
    }));
    await flushPromises();
    expect(result.subscriptions.data.value).toEqual([{ id: 1 }]);
    expect(result.categories.data.value).toEqual([{ id: 2 }]);
  });

  it('refetches feeds, categories, and counters after a change', async () => {
    const { result: refresh, queryClient } = withSetup(() => useFeedsRefresh());
    const invalidate = spyInvalidations(queryClient);
    await refresh();
    expect(invalidate.keys()).toEqual([SUBSCRIPTIONS_KEY, CATEGORIES_KEY, ['counters']]);
  });
});
