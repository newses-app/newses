import type { ArchivedEntry, Entry, EntryState } from '@rss-reader/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { api } from '../api.ts';
import { COUNTERS_KEY } from './useCounters.ts';
import { ENTRIES_KEY } from './useEntries.ts';

export const ARCHIVE_KEY = 'archive';
const PAGE_SIZE = 50;

export interface ArchiveListOptions {
  /** One subscription, or null for all of them. */
  subscriptionId: number | null;
  q: string | null;
}

/** Past articles of the user's feeds, newest first, loaded page by page. */
export function useArchiveList(options: MaybeRefOrGetter<ArchiveListOptions>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => {
      const o = toValue(options);
      return [ARCHIVE_KEY, 'list', o.subscriptionId, o.q] as const;
    }),
    queryFn: ({ pageParam }) => {
      const o = toValue(options);
      return api.archive.list({
        ...(o.subscriptionId !== null && { subscriptionId: o.subscriptionId }),
        ...(o.q && { q: o.q }),
        ...(pageParam && { cursor: pageParam }),
        limit: PAGE_SIZE,
      });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const entries = computed(() => query.data.value?.pages.flatMap((p) => p.entries) ?? []);
  return { ...query, entries };
}

/** One past article with content and enclosures. */
export function useArchivedEntry(key: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => [ARCHIVE_KEY, 'entry', toValue(key)] as const),
    queryFn: () => api.archive.get(toValue(key) ?? ''),
    enabled: computed(() => toValue(key) !== null),
  });
}

/** Brings a past article back into the user's feed with `state`; resolves to the entry. */
export function useRestore() {
  const queryClient = useQueryClient();
  return async function restore(entry: ArchivedEntry, state: EntryState): Promise<Entry> {
    const restored = await api.archive.restore(entry.key, state);
    await Promise.all(
      [[ARCHIVE_KEY], [ENTRIES_KEY], COUNTERS_KEY].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
    return restored;
  };
}
