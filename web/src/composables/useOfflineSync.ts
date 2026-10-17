import type { Entry, SyncResponse } from '@newses/shared';
import { type QueryClient, useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.ts';
import { replaceEntries } from '../lib/entry-cache.ts';
import { DEFAULT_KEEP, upsertById } from '../lib/offline-keep.ts';
import { markFilled, wasEvicted } from '../offline/account.ts';
import { connectivity, networkStatus } from '../offline/connectivity.ts';
import { exclusively, type OfflineDb } from '../offline/db.ts';
import { downloadContents, downloadImages } from '../offline/downloads.ts';
import { flushOutbox, flushRequests, loadPending } from '../offline/outbox.ts';
import {
  describeError,
  loadStatus,
  saveStatus,
  syncRequests,
  syncStatus,
} from '../offline/status.ts';
import { currentStore } from '../offline/store.ts';
import { pruneStore, supportsOffline, syncStore } from '../offline/sync.ts';
import { appServer, bridge } from '../platform/index.ts';
import { useUiStore } from '../stores/ui.ts';
import { COUNTERS_KEY, pollInBackground } from './useCounters.ts';
import { CATEGORIES_KEY, SUBSCRIPTIONS_KEY } from './useFeeds.ts';
import { ENTRIES_KEY } from './useEntries.ts';
import { LABELS_KEY } from './useLabels.ts';
import { sessionVerified } from './useSession.ts';

/** Changes kept offline are sent again after this, doubling up to five minutes. */
const RETRY_MS = 2000;
const MAX_RETRY_MS = 5 * 60_000;
/** Sync runs this often while the app is visible, and half as often while hidden. */
const INTERVAL_MS = 15 * 60_000;
/** Counters changes come in bursts (an action, then its event); sync once they settle. */
const SETTLE_MS = 2000;

/** Whether the server has the API the store needs; asked once per launch, again after failures. */
let supported: Promise<boolean> | null = null;
function serverSupportsOffline(): Promise<boolean> {
  supported ??= api.serverInfo().then(supportsOffline, () => {
    supported = null;
    return false;
  });
  return supported;
}

/** Shows synced changes in what is on screen; read entries stay in lists until they reload. */
function patchCaches(queryClient: QueryClient, changes: SyncResponse): void {
  if (changes.entries.length > 0) {
    const byId = new Map(changes.entries.map((e) => [e.id, e]));
    queryClient.setQueriesData({ queryKey: [ENTRIES_KEY] }, (data) =>
      replaceEntries(data as Parameters<typeof replaceEntries>[0], byId),
    );
    for (const entry of changes.entries) {
      const cached = queryClient.getQueryData<Entry>(['entry', entry.id]);
      if (!cached) continue;
      if (cached.contentVersion === entry.contentVersion)
        queryClient.setQueryData<Entry>(['entry', entry.id], { ...cached, ...entry });
      else void queryClient.invalidateQueries({ queryKey: ['entry', entry.id] });
    }
  }
  const patch = (key: readonly unknown[], changed: { id: number }[], deleted: number[]) => {
    if (changed.length > 0 || deleted.length > 0)
      queryClient.setQueryData<{ id: number }[]>(
        key,
        (list) => list && upsertById(list, changed, deleted),
      );
  };
  patch(SUBSCRIPTIONS_KEY, changes.subscriptions, changes.deleted.subscriptions);
  patch(CATEGORIES_KEY, changes.categories, changes.deleted.categories);
  patch(LABELS_KEY, changes.labels, changes.deleted.labels);
}

/**
 * Keeps the offline store current: at launch, when the app resumes or the server answers again,
 * when counters change (an event or the regular poll, so no extra polling), and every 15 minutes
 * (30 while hidden, and then only where counters are polled in the background). Mount once, in the
 * signed-in layout.
 */
export function useOfflineSync(): void {
  const queryClient = useQueryClient();
  const ui = useUiStore();
  const { t } = useI18n();
  let running: Promise<void> | null = null;
  /** Counts requests, so one made while a sync runs gets another after it. */
  let requested = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;

  /** Sends the changes kept on this device, oldest first; one tab at a time. */
  async function flush(db: OfflineDb): Promise<void> {
    if (!sessionVerified.value) return;
    await exclusively('outbox', async () => {
      const { sent, refused, stopped } = await flushOutbox(api, db);
      for (const { message } of refused) ui.notify(t('offline.refused', { error: message }), true);
      clearTimeout(retry);
      if (stopped === 'unreachable' || (typeof stopped === 'object' && stopped !== null)) {
        const delay =
          typeof stopped === 'object'
            ? stopped.retryAfterSeconds * 1000
            : Math.min(RETRY_MS * 2 ** retries++, MAX_RETRY_MS);
        retry = setTimeout(run, delay);
      } else retries = 0;
      // The server now has what was kept; counters and lists follow from the sync after this.
      if (sent > 0) void queryClient.invalidateQueries({ queryKey: COUNTERS_KEY });
    });
  }

  async function syncOnce(): Promise<void> {
    const db = currentStore();
    if (!db || connectivity.value !== 'online') return;
    syncStatus.unsupported = !(await serverSupportsOffline());
    if (syncStatus.unsupported) return;
    syncStatus.running = true;
    try {
      await flush(db);
      await exclusively('sync', async () => {
        const evicted = await wasEvicted(db);
        const result = await syncStore({
          api,
          db,
          beforeResync: () => flush(db),
          onChanges: (changes) => {
            patchCaches(queryClient, changes);
          },
        });
        await pruneStore(db, Date.now(), DEFAULT_KEEP);
        if (result === 'bootstrap') {
          markFilled();
          if (evicted) ui.notify(t('offline.evicted'));
        }
        syncStatus.lastSyncedAt = Date.now();
        syncStatus.lastError = null;
        // Text first, so every kept article can be read before any image arrives.
        const downloads = { api, db, server: appServer() ?? '' };
        await downloadContents({ ...downloads, images: false });
        await downloadImages({ ...downloads, images: networkStatus.value.wifi !== false });
      });
    } catch (error) {
      syncStatus.lastError = describeError(error);
      throw error;
    } finally {
      syncStatus.running = false;
      await saveStatus(db).catch(() => undefined);
    }
  }

  /** Runs a sync, or one more after the current one when asked while it runs. */
  function run(): void {
    requested++;
    if (running) return;
    running = (async () => {
      for (;;) {
        const seen = requested;
        await syncOnce().catch(() => undefined);
        if (requested === seen) return;
      }
    })().finally(() => {
      running = null;
    });
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (!document.hidden || pollInBackground.value) run();
        schedule();
      },
      document.hidden ? INTERVAL_MS * 2 : INTERVAL_MS,
    );
  }

  let counters = '';
  const stopCounters = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const key = event.query.queryKey as readonly unknown[];
    if (key[0] !== COUNTERS_KEY[0]) return;
    const current = JSON.stringify(event.query.state.data);
    if (current === counters) return;
    const first = counters === '';
    counters = current;
    if (first) return;
    clearTimeout(settle);
    settle = setTimeout(run, SETTLE_MS);
  });
  let stopRefresh: () => void = () => undefined;
  const stopOnline = watch(connectivity, (state) => {
    if (state === 'online') run();
  });
  const stopRequests = watch([syncRequests, flushRequests, sessionVerified], run);

  onMounted(() => {
    const db = currentStore();
    if (db) void loadStatus(db).catch(() => undefined);
    if (db) void loadPending(db).catch(() => undefined);
    run();
    schedule();
    stopRefresh = bridge.onRefresh(run);
  });
  onBeforeUnmount(() => {
    clearTimeout(timer);
    clearTimeout(settle);
    clearTimeout(retry);
    stopCounters();
    stopRefresh();
    stopOnline();
    stopRequests();
  });
}
