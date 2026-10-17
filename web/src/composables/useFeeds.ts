import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../api.ts';
import { storedQuery } from '../offline/local.ts';

export const SUBSCRIPTIONS_KEY = ['subscriptions'] as const;
export const CATEGORIES_KEY = ['categories'] as const;

export function useSubscriptions() {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    ...storedQuery('subscriptions', () => api.subscriptions.list()),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    ...storedQuery('categories', () => api.categories.list()),
  });
}

/** Refetches feeds, categories, and counters after a change to any of them. */
export function useFeedsRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY }),
      queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
      queryClient.invalidateQueries({ queryKey: ['counters'] }),
    ]);
}
