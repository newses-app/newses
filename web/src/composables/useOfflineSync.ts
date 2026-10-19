import type { Entry, SyncResponse } from '@newses/shared';
import { type QueryClient, useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.ts';
import { replaceEntries } from '../lib/entry-cache.ts';
import { upsertById } from '../lib/offline-keep.ts';
import { lastAccount, markFilled, wasEvicted } from '../offline/account.ts';
import { reportOf, takeWorkerReport, type WorkerReport } from '../offline/background.ts';
import { connectivity, networkStatus } from '../offline/connectivity.ts';
import { exclusively, type OfflineDb } from '../offline/db.ts';
import {
  downloadContents,
  downloadImages,
  indexStoredContents,
  trimToLimit,
} from '../offline/downloads.ts';
import { warmThemeFonts } from '../offline/fonts.ts';
import { flushOutbox, loadPending } from '../offline/outbox.ts';
import { setPeriodicSync } from '../offline/registration.ts';
import {
  backgroundState,
  describeError,
  flushRequests,
  keepThemeDrafts,
  loadStatus,
  loadThemeDrafts,
  noteConflicts,
  saveStatus,
  syncRequests,
  syncStatus,
} from '../offline/status.ts';
import { currentStore } from '../offline/store.ts';
import { imagesNow, keepLimits, offlineSettings } from '../offline/settings.ts';
import {
  detectsConflicts,
  pruneStore,
  storedSyncToken,
  supportsOffline,
  syncStore,
} from '../offline/sync.ts';
import { importStaged } from '../offline/staged.ts';
import { writeWorkerConfig } from '../offline/worker-config.ts';
import { appServer, bridge, connection, NATIVE } from '../platform/index.ts';
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

interface ServerSupport {
  offline: boolean;
  conflicts: boolean;
}

/**
 * What the server's API offers the store; null when the server couldn't be asked. Kept for the
 * server once offline is supported; asked again otherwise, as the server may be updated meanwhile.
 * The apps can change server without reloading, so the answer is kept per server.
 */
let support: { server: string | null; answer: Promise<ServerSupport | null> } | null = null;
function serverSupport(): Promise<ServerSupport | null> {
  const server = appServer();
  if (support?.server === server) return support.answer;
  const forget = () => {
    if (support?.server === server) support = null;
  };
  const answer = api.serverInfo().then(
    (info) => {
      // Profiles show the name the server gives itself, which its operator may change.
      if (NATIVE) void connection.rememberServerName(info.name ?? null).catch(() => undefined);
      const offline = supportsOffline(info);
      if (!offline) forget();
      return { offline, conflicts: detectsConflicts(info) };
    },
    () => {
      forget();
      return null;
    },
  );
  support = { server, answer };
  return answer;
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

  /** Tells the reader what sending changes did, here or in the service worker. */
  async function announce(db: OfflineDb, report: WorkerReport): Promise<void> {
    for (const { kind, code, message, url } of report.refused)
      ui.notify(
        kind === 'subscription.create' && code === 'choose'
          ? t('offline.subscribeChoose', { url: url ?? '' })
          : t('offline.refused', { error: message }),
        true,
      );
    if (report.themeDrafts.length > 0) {
      await keepThemeDrafts(db, report.themeDrafts);
      for (const { name } of report.themeDrafts) ui.notify(t('offline.themeDraft', { name }), true);
    }
    // Objects created offline now have the server's ids, or are gone; show what the server has.
    if (report.renumbered)
      await Promise.all(
        ['subscriptions', 'categories', 'labels', 'themes', 'prefs', ENTRIES_KEY, 'entry'].map(
          (name) => queryClient.invalidateQueries({ queryKey: [name] }),
        ),
      );
    if (report.overridden > 0)
      ui.notify(t('offline.overridden', { n: report.overridden }, report.overridden));
    noteConflicts.value = [...noteConflicts.value, ...report.noteConflicts];
  }

  /**
   * What happened while the app was closed: the Android job's staged pages, stored in order (even
   * offline, which is when they matter), and what the service worker reported.
   */
  async function takeBackground(db: OfflineDb): Promise<void> {
    if (NATIVE) {
      const pages = await bridge.takeBackgroundSync();
      if (pages.length === 0) return;
      await exclusively('sync', async () => {
        const staged = await importStaged(db, pages, { limits: keepLimits() });
        for (const changes of staged.changes) patchCaches(queryClient, changes);
      });
      return;
    }
    const report = await takeWorkerReport(db);
    if (report) {
      await announce(db, report);
      await loadStatus(db);
    }
  }

  /** Hands the background syncs what they need: settings, and where the store's sync stands. */
  async function publishBackground(db: OfflineDb): Promise<void> {
    const { background, wifiOnly, unread, limitBytes } = offlineSettings;
    if (NATIVE) {
      if (bridge.platform === 'android')
        await bridge.setBackgroundSync({
          enabled: background,
          wifiOnly,
          syncToken: await storedSyncToken(db),
        });
      return;
    }
    const account = lastAccount();
    await writeWorkerConfig(account ? { dbName: account.name, unread, limitBytes } : null);
    backgroundState.value = await setPeriodicSync(background);
  }

  /** Sends the changes kept on this device, oldest first; one tab at a time. */
  async function flush(db: OfflineDb, conflicts: boolean): Promise<void> {
    if (!sessionVerified.value) return;
    await exclusively('outbox', async () => {
      const result = await flushOutbox(api, db, { conflicts });
      const { sent, stopped } = result;
      await announce(db, reportOf(result));
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
    if (!db) return;
    await takeBackground(db).catch(() => undefined);
    if (connectivity.value !== 'online') return;
    // Not reached is not unsupported: the next sync asks again.
    const server = await serverSupport();
    syncStatus.unsupported = server?.offline === false;
    if (!server) return;
    if (syncStatus.unsupported) return;
    const { conflicts } = server;
    syncStatus.running = true;
    if (!NATIVE) warmThemeFonts();
    try {
      await flush(db, conflicts);
      await exclusively('sync', async () => {
        const evicted = await wasEvicted(db);
        const result = await syncStore({
          api,
          db,
          limits: keepLimits(),
          beforeResync: () => flush(db, conflicts),
          onChanges: (changes) => {
            patchCaches(queryClient, changes);
          },
        });
        await pruneStore(db, Date.now(), keepLimits());
        if (result === 'bootstrap') {
          markFilled();
          if (evicted) ui.notify(t('offline.evicted'));
        }
        syncStatus.lastSyncedAt = Date.now();
        syncStatus.lastError = null;
        // Text first, so every kept article can be read before any image arrives.
        const { limitBytes } = offlineSettings;
        if (!offlineSettings.images) await db.images.clear();
        // Content stored before search existed; new content is indexed as it downloads.
        await indexStoredContents(db);
        await trimToLimit(db, limitBytes);
        const downloads = { api, db, server: appServer() ?? '', limitBytes };
        await downloadContents({ ...downloads, images: false });
        await downloadImages({ ...downloads, images: imagesNow(networkStatus.value.wifi) });
      });
      await publishBackground(db).catch(() => undefined);
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
    if (db) void loadThemeDrafts(db).catch(() => undefined);
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
