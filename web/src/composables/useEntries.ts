import type {
  Counters,
  Entry,
  EntryListResponse,
  EntryState,
  MarkReadRequest,
} from '@newses/shared';
import { normaliseTags } from '@newses/shared/client';
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { api } from '../api.ts';
import { patchEntryPages, statePatch } from '../lib/entry-cache.ts';
import { adjustCounters, type CounterChange } from '../lib/offline-counters.ts';
import { parseStream, type StreamKey } from '../lib/streams.ts';
import { connectivity } from '../offline/connectivity.ts';
import type { OfflineDb } from '../offline/db.ts';
import {
  changeStored,
  localCatchUp,
  localEntry,
  localList,
  networkOrStore,
  newestStoredId,
  storedStreamContext,
  storeNetworkMode,
} from '../offline/local.ts';
import {
  failedToReach,
  flushRequests,
  type OutboxOp,
  queueChanges,
  withPending,
} from '../offline/outbox.ts';
import { sendOrQueue } from './sendOrQueue.ts';
import { currentStore, keepLoaded } from '../offline/store.ts';
import { COUNTERS_KEY, live } from './useCounters.ts';
import { sessionVerified } from './useSession.ts';
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
        const db = currentStore();
        return db ? { ...page, entries: await withPending(db, page.entries) } : page;
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
          async () => {
            const entry = await api.entries.get(entryId);
            return db ? ((await withPending(db, [entry]))[0] ?? entry) : entry;
          },
          (store) => localEntry(store, entryId),
        )
      );
    },
    networkMode: storeNetworkMode(),
    enabled: computed(() => toValue(id) !== null),
  });
}

/**
 * Changes applied to every cached copy first, then saved: at once while the server can be reached,
 * otherwise (with offline reading on) kept in the outbox and sent when it can be.
 */
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

  /** Counters as the server will count them once it has changes kept on this device. */
  async function countQueued(db: OfflineDb, changes: CounterChange[]): Promise<void> {
    const counters = queryClient.getQueryData<Counters>(COUNTERS_KEY);
    if (!counters || changes.length === 0) return;
    const { context } = await storedStreamContext(db);
    queryClient.setQueryData(COUNTERS_KEY, adjustCounters(counters, changes, context));
  }

  async function save(
    ops: OutboxOp[],
    request: () => Promise<unknown>,
  ): Promise<'sent' | 'queued'> {
    return (await sendOrQueue(ops, request)).sent ? 'sent' : 'queued';
  }

  /** Keeps the store as fresh as the caches, and counts a kept change until the server has it. */
  async function saved(
    how: 'sent' | 'queued',
    entries: readonly Entry[],
    patch: Partial<Entry>,
  ): Promise<void> {
    const db = currentStore();
    if (db) {
      await changeStored(
        db,
        entries.map((e) => e.id),
        patch,
      ).catch(() => undefined);
    }
    if (how === 'sent') refreshCounters();
    else if (db)
      await countQueued(
        db,
        entries.map((before) => ({ before, after: { ...before, ...patch } })),
      );
  }

  async function setState(entries: Entry[], state: EntryState): Promise<void> {
    const changed = entries.filter((e) =>
      Object.entries(state).some(([flag, value]) => e[flag as keyof EntryState] !== value),
    );
    if (changed.length === 0) return;
    const ids = changed.map((e) => e.id);
    const patch = statePatch(state);
    patchCaches(ids, patch);
    let how: 'sent' | 'queued';
    try {
      how = await save(
        changed.map((entry) => ({
          kind: 'state',
          id: entry.id,
          state,
          expect: Object.fromEntries(
            Object.keys(state).map((flag) => [flag, entry[flag as keyof EntryState]]),
          ),
        })),
        () =>
          ids.length === 1
            ? api.entries.update(ids[0] ?? 0, state)
            : api.entries.updateMany({ ids, ...state }),
      );
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
    await saved(how, changed, patch);
  }

  /** Saves the entry's note; null or blank text clears it. */
  async function setNote(entry: Entry, note: string | null): Promise<void> {
    const patch = { note: note?.trim() || null };
    patchCaches([entry.id], patch);
    let how: 'sent' | 'queued';
    try {
      how = await save([{ kind: 'note', id: entry.id, note, expected: entry.note }], () =>
        api.entries.setNote(entry.id, note),
      );
    } catch (error) {
      patchCaches([entry.id], { note: entry.note });
      throw error;
    }
    await saved(how, [entry], patch);
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
    let patch: Partial<Entry> = { tags: normaliseTags(tags).sort() };
    patchCaches([entry.id], patch);
    let how: 'sent' | 'queued';
    try {
      how = await save([{ kind: 'tags', id: entry.id, tags, base: entry.tags }], async () => {
        patch = await api.entries.setTags(entry.id, tags);
      });
      patchCaches([entry.id], patch);
    } catch (error) {
      patchCaches([entry.id], { tags: entry.tags });
      throw error;
    } finally {
      void queryClient.invalidateQueries({ queryKey: TAGS_KEY });
    }
    await saved(how, [entry], patch);
  }

  /** Replaces the entry's labels. */
  async function setLabels(entry: Entry, labelIds: number[]): Promise<void> {
    const patch = { labels: [...labelIds].sort((a, b) => a - b) };
    patchCaches([entry.id], patch);
    let how: 'sent' | 'queued';
    try {
      how = await save([{ kind: 'labels', id: entry.id, labelIds, base: entry.labels }], () =>
        api.entries.setLabels(entry.id, labelIds),
      );
    } catch (error) {
      patchCaches([entry.id], { labels: entry.labels });
      throw error;
    }
    await saved(how, [entry], patch);
  }

  /**
   * Catch-up on the stored entries, kept for the server with the newest id the device knows of,
   * so entries that arrive before it is sent stay unread.
   */
  async function catchUpStored(db: OfflineDb, request: MarkReadRequest): Promise<number> {
    const maxId = request.maxId ?? (await newestStoredId(db));
    const kept = { ...request, ...(maxId !== undefined && { maxId }) };
    const caught = await localCatchUp(db, kept);
    await queueChanges(db, [{ kind: 'markRead', request: kept }]);
    flushRequests.value++;
    patchCaches(
      caught.map((e) => e.id),
      { unread: false },
    );
    await countQueued(
      db,
      caught.map((before) => ({ before, after: { ...before, unread: false } })),
    );
    await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
    return caught.length;
  }

  async function markRead(request: MarkReadRequest): Promise<number> {
    const db = currentStore();
    if (
      db &&
      (connectivity.value !== 'online' || !sessionVerified.value || (await db.outbox.count()) > 0)
    )
      return catchUpStored(db, request);
    let updated: number;
    try {
      ({ updated } = await api.entries.markRead(request));
    } catch (error) {
      if (db && failedToReach(error)) return catchUpStored(db, request);
      throw error;
    }
    await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
    refreshCounters();
    return updated;
  }

  return { setState, setNote, setTags, setLabels, share, unshare, markRead };
}
