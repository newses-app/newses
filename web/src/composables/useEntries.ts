import type { Entry, EntryListResponse, EntryState, MarkReadRequest } from '@newses/shared';
import { normaliseTags } from '@newses/shared/client';
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { api } from '../api.ts';
import { patchEntryPages, statePatch } from '../lib/entry-cache.ts';
import { parseStream, type StreamKey } from '../lib/streams.ts';
import { localEntry, localList, networkOrStore, storeNetworkMode } from '../offline/local.ts';
import { currentStore, keepLoaded } from '../offline/store.ts';
import { COUNTERS_KEY, live } from './useCounters.ts';
import { TAGS_KEY } from './useTags.ts';

export const ENTRIES_KEY = 'entries';
export const SHARES_KEY = ['shares'] as const;
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
      const remote = async () => {
        const page = await api.entries.list({
          ...parseStream(o.stream),
          view: o.view,
          ...(o.q ? { q: o.q } : { order: o.order }),
          ...(pageParam && { cursor: pageParam }),
          content: o.content,
          limit: PAGE_SIZE,
        });
        void keepLoaded(page.entries);
        return page;
      };
      // Search needs the server until the store can search.
      return networkOrStore(remote, (db) =>
        o.q
          ? Promise.resolve(undefined)
          : localList(db, {
              stream: parseStream(o.stream),
              view: o.view,
              order: o.order,
              cursor: pageParam || undefined,
              limit: PAGE_SIZE,
              content: o.content,
            }),
      );
    },
    networkMode: storeNetworkMode(),
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
    queryFn: async () => {
      const entryId = toValue(id) ?? 0;
      // A stored copy with current content opens without asking the server.
      const db = currentStore();
      const current = db && (await localEntry(db, entryId, true).catch(() => undefined));
      return (
        current ??
        networkOrStore(
          () => api.entries.get(entryId),
          (store) => localEntry(store, entryId),
        )
      );
    },
    networkMode: storeNetworkMode(),
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

  /** Saves the entry's note; null or blank text clears it. */
  async function setNote(entry: Entry, note: string | null): Promise<void> {
    patchCaches([entry.id], { note: note?.trim() || null });
    try {
      await api.entries.setNote(entry.id, note);
    } catch (error) {
      patchCaches([entry.id], { note: entry.note });
      throw error;
    }
  }

  /** Shares the entry at a public link; returns the link's id. */
  async function share(entry: Entry): Promise<string> {
    const { shareId } = await api.entries.share(entry.id);
    patchCaches([entry.id], { shareId });
    void queryClient.invalidateQueries({ queryKey: SHARES_KEY });
    return shareId;
  }

  /** Revokes the entry's share link. */
  async function unshare(entry: Pick<Entry, 'id'>): Promise<void> {
    await api.entries.unshare(entry.id);
    patchCaches([entry.id], { shareId: null });
    void queryClient.invalidateQueries({ queryKey: SHARES_KEY });
  }

  /** Replaces the entry's tags. */
  async function setTags(entry: Entry, tags: string[]): Promise<void> {
    patchCaches([entry.id], { tags: normaliseTags(tags).sort() });
    try {
      patchCaches([entry.id], await api.entries.setTags(entry.id, tags));
    } catch (error) {
      patchCaches([entry.id], { tags: entry.tags });
      throw error;
    } finally {
      void queryClient.invalidateQueries({ queryKey: TAGS_KEY });
    }
  }

  /** Replaces the entry's labels. */
  async function setLabels(entry: Entry, labelIds: number[]): Promise<void> {
    patchCaches([entry.id], { labels: [...labelIds].sort((a, b) => a - b) });
    try {
      await api.entries.setLabels(entry.id, labelIds);
    } catch (error) {
      patchCaches([entry.id], { labels: entry.labels });
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

  return { setState, setNote, setTags, setLabels, share, unshare, markRead };
}
