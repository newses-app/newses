import type {
  Category,
  Subscription,
  UpdateCategoryRequest,
  UpdateSubscriptionRequest,
} from '@newses/shared';
import { useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api.ts';
import { byDisplayOrder, reorder } from '../lib/reorder.ts';
import { useUiStore } from '../stores/ui.ts';
import { CATEGORIES_KEY, SUBSCRIPTIONS_KEY, useFeedsRefresh } from './useFeeds.ts';
import { useResourceEdits } from './useResourceEdits.ts';

export type Dragged = { kind: 'feed' | 'category'; id: number };

/** Moves and reorders feeds and categories, and persists collapsed state; offline, kept for later. */
export function useTreeEditing() {
  const queryClient = useQueryClient();
  const refresh = useFeedsRefresh();
  const ui = useUiStore();
  const { t } = useI18n();
  const { edit } = useResourceEdits();
  const updateFeed = (id: number, changes: UpdateSubscriptionRequest) =>
    edit({ kind: 'subscription.update', id, changes }, () => api.subscriptions.update(id, changes));
  const updateCategory = (id: number, changes: UpdateCategoryRequest) =>
    edit({ kind: 'category.update', id, changes }, () => api.categories.update(id, changes));

  const subscriptions = () => queryClient.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY) ?? [];
  const categories = () => queryClient.getQueryData<Category[]>(CATEGORIES_KEY) ?? [];

  async function run(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
    } finally {
      await refresh();
    }
  }

  /** Moves a feed into `categoryId`, before `beforeId` or last. */
  function moveFeed(id: number, categoryId: number | null, beforeId: number | null) {
    const siblings = subscriptions()
      .filter((s) => s.categoryId === categoryId)
      .sort(byDisplayOrder);
    const changes = reorder(siblings, id, beforeId);
    return run(() =>
      Promise.all(
        changes.map((c) =>
          updateFeed(c.id, { sortOrder: c.sortOrder, ...(c.id === id && { categoryId }) }),
        ),
      ),
    );
  }

  /** Moves a category under `parentId`, before `beforeId` or last. */
  function moveCategory(id: number, parentId: number | null, beforeId: number | null) {
    if (id === parentId) return Promise.resolve();
    const siblings = categories()
      .filter((c) => c.parentId === parentId)
      .sort(byDisplayOrder);
    const changes = reorder(siblings, id, beforeId);
    return run(async () => {
      // The moved category first, so a refused move (into its own subtree) changes nothing.
      const moved = changes.find((c) => c.id === id);
      if (moved) await updateCategory(id, { parentId, sortOrder: moved.sortOrder });
      await Promise.all(
        changes
          .filter((c) => c.id !== id)
          .map((c) => updateCategory(c.id, { sortOrder: c.sortOrder })),
      );
    });
  }

  async function setCollapsed(id: number, collapsed: boolean) {
    queryClient.setQueryData<Category[]>(CATEGORIES_KEY, (list) =>
      list?.map((c) => (c.id === id ? { ...c, collapsed } : c)),
    );
    await updateCategory(id, { collapsed }).catch(() => refresh());
  }

  async function setAllCollapsed(collapsed: boolean) {
    queryClient.setQueryData<Category[]>(CATEGORIES_KEY, (list) =>
      list?.map((c) => ({ ...c, collapsed })),
    );
    await edit({ kind: 'categories.collapse', collapsed }, () =>
      api.categories.updateAll({ collapsed }),
    ).catch(() => refresh());
  }

  return { moveFeed, moveCategory, setCollapsed, setAllCollapsed };
}
