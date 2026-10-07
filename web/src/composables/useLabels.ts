import type { CreateLabelRequest, Label, UpdateLabelRequest } from '@rss-reader/shared';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../api.ts';
import { COUNTERS_KEY } from './useCounters.ts';
import { ENTRIES_KEY } from './useEntries.ts';

export const LABELS_KEY = ['labels'] as const;

export function useLabels() {
  return useQuery({ queryKey: LABELS_KEY, queryFn: () => api.labels.list() });
}

/** Label changes, each followed by refetching what shows labels. */
export function useLabelActions() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: LABELS_KEY }),
      queryClient.invalidateQueries({ queryKey: COUNTERS_KEY }),
    ]);

  async function create(label: CreateLabelRequest): Promise<Label> {
    const created = await api.labels.create(label);
    await refresh();
    return created;
  }

  async function update(id: number, changes: UpdateLabelRequest): Promise<void> {
    await api.labels.update(id, changes);
    await refresh();
  }

  /** Deleting a label also removes it from cached entries. */
  async function remove(id: number): Promise<void> {
    await api.labels.delete(id);
    await Promise.all([
      refresh(),
      queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] }),
      queryClient.invalidateQueries({ queryKey: ['entry'] }),
    ]);
  }

  return { create, update, remove };
}
