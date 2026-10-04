import type { Entry, EntryListResponse, EntryState, MarkReadRequest } from '@rss-reader/shared';
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { api } from '../api.ts';
import { patchEntryPages, statePatch } from '../lib/entry-cache.ts';
import { parseStream, type StreamKey } from '../lib/streams.ts';
import { COUNTERS_KEY, live } from './useCounters.ts';

export const ENTRIES_KEY = 'entries';
const PAGE_SIZE = 50;

export interface EntryListOptions {
  stream: StreamKey;
  view: 'all' | 'unread' | 'adaptive';
  order: 'newest' | 'oldest' | 'title';
  q: string | null;
  content: boolean;
}

/** Headlines of a stream, loaded page by page with the API's cursor. */
export function useEntryList(options: MaybeRefOrGetter<EntryListOptions>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => {
      const o = toValue(options);
      return [ENTRIES_KEY, o.stream, o.view, o.q ? 'relevance' : o.order, o.q, o.content] as const;
    }),
    queryFn: ({ pageParam }) => {
      const o = toValue(options);
      return api.entries.list({
        ...parseStream(o.stream),
        view: o.view,
        ...(o.q ? { q: o.q } : { order: o.order }),
        ...(pageParam && { cursor: pageParam }),
        content: o.content,
        limit: PAGE_SIZE,
      });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const entries = computed(() => query.data.value?.pages.flatMap((p) => p.entries) ?? []);
  return { ...query, entries };
}

/** One entry with content and enclosures. */
export function useEntry(id: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => ['entry', toValue(id)] as const),
    queryFn: () => api.entries.get(toValue(id) ?? 0),
    enabled: computed(() => toValue(id) !== null),
  });
}

/** State changes applied to every cached copy first, then saved. */
export function useEntryActions() {
  const queryClient = useQueryClient();

  const patchCaches = (ids: number[], patch: Partial<Entry>) => {
    const set = new Set(ids);
    queryClient.setQueriesData<InfiniteData<EntryListResponse>>(
      { queryKey: [ENTRIES_KEY] },
      (data) => patchEntryPages(data, set, patch),
    );
    for (const id of ids)
      queryClient.setQueryData<Entry>(['entry', id], (entry) => entry && { ...entry, ...patch });
  };

  const refreshCounters = () => {
    if (!live.value) void queryClient.invalidateQueries({ queryKey: COUNTERS_KEY });
  };

  async function setState(entries: Entry[], state: EntryState): Promise<void> {
    const changed = entries.filter((e) =>
      Object.entries(state).some(([flag, value]) => e[flag as keyof EntryState] !== value),
    );
    if (changed.length === 0) return;
    const ids = changed.map((e) => e.id);
    patchCaches(ids, statePatch(state));
    try {
      if (ids.length === 1) await api.entries.update(ids[0] ?? 0, state);
      else await api.entries.updateMany({ ids, ...state });
    } catch (error) {
      // Restore each entry's previous flags.
      for (const entry of changed) {
        const previous = Object.fromEntries(
          Object.keys(state).map((flag) => [flag, entry[flag as keyof EntryState]]),
        );
        patchCaches([entry.id], previous);
      }
      throw error;
    }
    refreshCounters();
  }

  async function markRead(request: MarkReadRequest): Promise<number> {
    const { updated } = await api.entries.markRead(request);
    await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
    refreshCounters();
    return updated;
  }

  return { setState, markRead };
}
