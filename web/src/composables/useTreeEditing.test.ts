import type { Category, Subscription } from '@newses/shared';
import { ApiError } from '@newses/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../stores/ui.ts';
import { withSetup } from '../test/mount.ts';
import { spyInvalidations } from '../test/queries.ts';
import { CATEGORIES_KEY, SUBSCRIPTIONS_KEY } from './useFeeds.ts';
import { useTreeEditing } from './useTreeEditing.ts';

const api = vi.hoisted(() => ({
  subscriptions: { update: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()) },
  categories: {
    update: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
    updateAll: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  },
}));
vi.mock('../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const feed = (id: number, categoryId: number | null, sortOrder: number) =>
  ({ id, categoryId, sortOrder, title: `F${String(id)}` }) as Subscription;
const category = (id: number, parentId: number | null, sortOrder: number) =>
  ({ id, parentId, sortOrder, title: `C${String(id)}`, collapsed: false }) as Category;

function setup() {
  const mounted = withSetup(() => useTreeEditing());
  const { queryClient } = mounted;
  queryClient.setQueryData(SUBSCRIPTIONS_KEY, [feed(1, 10, 0), feed(2, 10, 1), feed(3, 20, 0)]);
  queryClient.setQueryData(CATEGORIES_KEY, [
    category(10, null, 0),
    category(20, null, 1),
    category(30, 10, 0),
  ]);
  const invalidate = spyInvalidations(queryClient);
  return { ...mounted, editing: mounted.result, ui: useUiStore(mounted.pinia), invalidate };
}

const refused = () => new ApiError(422, 'invalid', 'Not into itself', null);

beforeEach(() => {
  api.subscriptions.update.mockImplementation(() => Promise.resolve());
  api.categories.update.mockImplementation(() => Promise.resolve());
  api.categories.updateAll.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTreeEditing', () => {
  it('moves a feed into another category, renumbering what follows, then refreshes', async () => {
    const { editing, invalidate } = setup();
    await editing.moveFeed(1, 20, 3);
    expect(api.subscriptions.update.mock.calls).toEqual([
      [1, { sortOrder: 0, categoryId: 20 }],
      [3, { sortOrder: 1 }],
    ]);
    expect(invalidate.keys()).toEqual([SUBSCRIPTIONS_KEY, CATEGORIES_KEY, ['counters']]);
  });

  it('reorders a feed within its category', async () => {
    const { editing } = setup();
    await editing.moveFeed(2, 10, 1);
    expect(api.subscriptions.update.mock.calls).toEqual([
      [2, { sortOrder: 0, categoryId: 10 }],
      [1, { sortOrder: 1 }],
    ]);
  });

  it('says why a move failed, and still refreshes', async () => {
    api.subscriptions.update.mockImplementation(() => Promise.reject(refused()));
    const { editing, ui, invalidate } = setup();
    await editing.moveFeed(1, null, null);
    expect(ui.notice?.error).toBe(true);
    expect(invalidate.spy).toHaveBeenCalled();
  });

  it('moves a category before renumbering its new siblings', async () => {
    const { editing } = setup();
    await editing.moveCategory(30, null, 20);
    expect(api.categories.update.mock.calls).toEqual([
      [30, { parentId: null, sortOrder: 1 }],
      [20, { sortOrder: 2 }],
    ]);
  });

  it('renumbers nothing when the server refuses the move', async () => {
    api.categories.update.mockImplementation(() => Promise.reject(refused()));
    const { editing, ui } = setup();
    await editing.moveCategory(10, 30, null);
    expect(api.categories.update).toHaveBeenCalledOnce();
    expect(ui.notice?.error).toBe(true);
  });

  it('never moves a category into itself', async () => {
    const { editing, invalidate } = setup();
    await editing.moveCategory(10, 10, null);
    expect(api.categories.update).not.toHaveBeenCalled();
    expect(invalidate.spy).not.toHaveBeenCalled();
  });

  it('collapses a category at once, refetching only if saving fails', async () => {
    const { editing, queryClient, invalidate } = setup();
    await editing.setCollapsed(10, true);
    const collapsed = () =>
      queryClient.getQueryData<Category[]>(CATEGORIES_KEY)?.map((c) => [c.id, c.collapsed]);
    expect(collapsed()).toEqual([
      [10, true],
      [20, false],
      [30, false],
    ]);
    expect(api.categories.update).toHaveBeenCalledWith(10, { collapsed: true });
    expect(invalidate.spy).not.toHaveBeenCalled();

    api.categories.update.mockImplementation(() => Promise.reject(refused()));
    await editing.setCollapsed(10, false);
    expect(invalidate.spy).toHaveBeenCalled();
  });

  it('collapses or expands every category at once', async () => {
    const { editing, queryClient, invalidate } = setup();
    await editing.setAllCollapsed(true);
    expect(queryClient.getQueryData<Category[]>(CATEGORIES_KEY)?.every((c) => c.collapsed)).toBe(
      true,
    );
    expect(api.categories.updateAll).toHaveBeenCalledWith({ collapsed: true });
    expect(invalidate.spy).not.toHaveBeenCalled();

    api.categories.updateAll.mockImplementation(() => Promise.reject(refused()));
    await editing.setAllCollapsed(false);
    expect(invalidate.spy).toHaveBeenCalled();
  });
});
