import type {
  CreateLabelRequest,
  Entry,
  EntryListResponse,
  Label,
  UpdateLabelRequest,
} from '@newses/shared';
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../api.ts';
import { temporaryId } from '../lib/offline-resources.ts';
import { storedQuery } from '../offline/local.ts';
import { currentStore } from '../offline/store.ts';
import { COUNTERS_KEY } from './useCounters.ts';
import { ENTRIES_KEY } from './useEntries.ts';
import { useResourceEdits } from './useResourceEdits.ts';

export const LABELS_KEY = ['labels'] as const;

export function useLabels() {
  return useQuery({ queryKey: LABELS_KEY, ...storedQuery('labels', () => api.labels.list()) });
}

/**
 * Label changes, each followed by refetching what shows labels once sent; without a connection
 * they are kept and shown until they can be.
 */
export function useLabelActions() {
  const queryClient = useQueryClient();
  const { edit } = useResourceEdits();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: LABELS_KEY }),
      queryClient.invalidateQueries({ queryKey: COUNTERS_KEY }),
    ]);

  /** The label made, or one with a temporary id until the server has it. */
  async function create(label: CreateLabelRequest): Promise<Label> {
    const id = temporaryId();
    const saved = await edit({ kind: 'label.create', id, body: label }, () =>
      api.labels.create(label),
    );
    if (!saved.sent) return { id, ...label };
    await refresh();
    return saved.value;
  }

  async function update(id: number, changes: UpdateLabelRequest): Promise<void> {
    const saved = await edit({ kind: 'label.update', id, changes }, () =>
      api.labels.update(id, changes),
    );
    if (saved.sent) await refresh();
  }

  /** Deleting a label also removes it from entries. */
  async function remove(id: number): Promise<void> {
    const saved = await edit({ kind: 'label.delete', id }, () => api.labels.delete(id));
    if (saved.sent) {
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] }),
        queryClient.invalidateQueries({ queryKey: ['entry'] }),
      ]);
      return;
    }
    const unlabel = (entry: Entry) => ({ ...entry, labels: entry.labels.filter((l) => l !== id) });
    queryClient.setQueriesData<InfiniteData<EntryListResponse>>(
      { queryKey: [ENTRIES_KEY] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({ ...page, entries: page.entries.map(unlabel) })),
        },
    );
    queryClient.setQueriesData<Entry>({ queryKey: ['entry'] }, (entry) => entry && unlabel(entry));
    await currentStore()
      ?.entries.where('labels')
      .equals(id)
      .modify((entry) => {
        entry.labels = entry.labels.filter((l) => l !== id);
      })
      .catch(() => undefined);
  }

  return { create, update, remove };
}
