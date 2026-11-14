import type { Entry, EntryListResponse, Subscription, SyncResponse } from '@newses/shared';
import { ApiError } from '@newses/shared/client';
import { type InfiniteData, QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReport } from '../offline/background.ts';
import type { FlushResult } from '../offline/outbox.ts';
import {
  backgroundState,
  flushRequests,
  noteConflicts,
  syncRequests,
  syncStatus,
} from '../offline/status.ts';
import { useUiStore } from '../stores/ui.ts';
import { connectivity } from '../test/connectivity.ts';
import { withSetup } from '../test/mount.ts';
import { spyInvalidations } from '../test/queries.ts';
import { COUNTERS_KEY, pollInBackground } from './useCounters.ts';
import { SUBSCRIPTIONS_KEY } from './useFeeds.ts';
import { useOfflineSync } from './useOfflineSync.ts';
import { sessionVerified } from './useSession.ts';

/** What the mocked modules do, and what was done to them, in order. */
const h = vi.hoisted(() => ({
  server: '',
  db: null as object | null,
  log: [] as string[],
  refresh: null as (() => void) | null,
}));
const fakes = vi.hoisted(() => {
  const step = (name: string, value?: unknown) =>
    vi.fn<(...args: unknown[]) => Promise<unknown>>(() => {
      h.log.push(name);
      return Promise.resolve(value);
    });
  return {
    step,
    serverInfo: vi.fn(),
    flushOutbox: vi.fn(),
    syncStore: vi.fn(),
    takeWorkerReport: vi.fn(),
    wasEvicted: vi.fn(),
    markFilled: vi.fn(),
    pruneStore: step('prune'),
    indexStoredContents: step('index'),
    trimToLimit: step('trim'),
    downloadContents: step('contents'),
    downloadImages: step('images'),
    writeWorkerConfig: step('workerConfig'),
    setPeriodicSync: step('periodicSync', 'on'),
    saveStatus: step('saveStatus'),
    loadStatus: step('loadStatus'),
    keepThemeDrafts: step('keepThemeDrafts'),
    warmThemeFonts: vi.fn(),
  };
});

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { serverInfo: fakes.serverInfo },
}));
vi.mock('../platform/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../platform/index.ts')>();
  return {
    ...original,
    appServer: () => h.server,
    bridge: {
      ...original.bridge,
      onRefresh: (listener: () => void) => {
        h.refresh = listener;
        return () => {
          h.refresh = null;
        };
      },
    },
  };
});
vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/connectivity.ts')),
}));
vi.mock('../offline/store.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentStore: () => h.db,
}));
vi.mock('../offline/db.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exclusively: async (_: string, task: () => Promise<void>) => {
    await task();
    return true;
  },
}));
vi.mock('../offline/sync.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supportsOffline: (info: { offline: boolean }) => info.offline,
  detectsConflicts: (info: { conflicts?: boolean }) => info.conflicts ?? false,
  storedSyncToken: () => Promise.resolve(null),
  syncStore: fakes.syncStore,
  pruneStore: fakes.pruneStore,
}));
vi.mock('../offline/outbox.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flushOutbox: fakes.flushOutbox,
  loadPending: () => Promise.resolve(0),
}));
vi.mock('../offline/background.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeWorkerReport: fakes.takeWorkerReport,
}));
vi.mock('../offline/account.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lastAccount: () => ({ name: 'newses-1' }),
  wasEvicted: fakes.wasEvicted,
  markFilled: fakes.markFilled,
}));
vi.mock('../offline/downloads.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  indexStoredContents: fakes.indexStoredContents,
  trimToLimit: fakes.trimToLimit,
  downloadContents: fakes.downloadContents,
  downloadImages: fakes.downloadImages,
}));
vi.mock('../offline/worker-config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeWorkerConfig: fakes.writeWorkerConfig,
}));
vi.mock('../offline/registration.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPeriodicSync: fakes.setPeriodicSync,
  requestOutboxSync: () => Promise.resolve(),
}));
vi.mock('../offline/status.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadStatus: fakes.loadStatus,
  saveStatus: fakes.saveStatus,
  loadThemeDrafts: () => Promise.resolve(),
  keepThemeDrafts: fakes.keepThemeDrafts,
}));
vi.mock('../offline/fonts.ts', () => ({ warmThemeFonts: fakes.warmThemeFonts }));

enableAutoUnmount(afterEach);

const flushed = (result: Partial<FlushResult> = {}): FlushResult => ({
  sent: 0,
  overridden: 0,
  noteConflicts: [],
  refused: [],
  created: [],
  dropped: [],
  themeDrafts: [],
  stopped: null,
  ...result,
});

const changes = (result: Partial<SyncResponse> = {}): SyncResponse => ({
  categories: [],
  subscriptions: [],
  labels: [],
  entries: [],
  deleted: { categories: [], subscriptions: [], labels: [], entries: [] },
  next: 't',
  more: false,
  ...result,
});

const entry = (id: number, fields: Partial<Entry> = {}) =>
  ({ id, title: `E${String(id)}`, contentVersion: 'v1', unread: true, ...fields }) as Entry;

let servers = 0;
let hidden: boolean;

/** Lets every sync step that is ready run, timers included. */
const settle = () => vi.advanceTimersByTimeAsync(0);

function setup() {
  const mounted = withSetup(() => {
    useOfflineSync();
  });
  const ui = useUiStore(mounted.pinia);
  const notify = vi.spyOn(ui, 'notify');
  return { ...mounted, notify, notices: () => notify.mock.calls.map(([text]) => text) };
}

beforeEach(() => {
  vi.useFakeTimers();
  // A new server for each test, so none sees what another asked the server.
  h.server = `https://s${String(++servers)}.example`;
  h.db = { images: { clear: () => Promise.resolve() } };
  h.log = [];
  connectivity.value = 'online';
  sessionVerified.value = true;
  pollInBackground.value = false;
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  Object.assign(syncStatus, {
    running: false,
    lastSyncedAt: null,
    lastError: null,
    unsupported: false,
  });
  noteConflicts.value = [];
  backgroundState.value = null;
  fakes.serverInfo.mockResolvedValue({ offline: true, conflicts: true });
  fakes.flushOutbox.mockImplementation(() => {
    h.log.push('flush');
    return Promise.resolve(flushed());
  });
  fakes.syncStore.mockImplementation(() => {
    h.log.push('sync');
    return Promise.resolve('changes');
  });
  fakes.takeWorkerReport.mockResolvedValue(null);
  fakes.wasEvicted.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useOfflineSync', () => {
  it('at launch, sends kept changes, syncs, then downloads text before images', async () => {
    setup();
    await settle();
    expect(h.log).toEqual([
      'loadStatus',
      'flush',
      'sync',
      'prune',
      'index',
      'trim',
      'contents',
      'images',
      'workerConfig',
      'periodicSync',
      'saveStatus',
    ]);
    expect(fakes.flushOutbox).toHaveBeenCalledWith(expect.anything(), h.db, { conflicts: true });
    expect(fakes.downloadContents).toHaveBeenCalledWith(
      expect.objectContaining({ server: h.server, images: false }),
    );
    expect(fakes.writeWorkerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dbName: 'newses-1' }),
    );
    expect(fakes.warmThemeFonts).toHaveBeenCalled();
    expect(backgroundState.value).toBe('on');
    expect(syncStatus).toMatchObject({ running: false, lastError: null, unsupported: false });
    expect(syncStatus.lastSyncedAt).toBe(Date.now());
  });

  it('does nothing without a store', async () => {
    h.db = null;
    setup();
    await settle();
    expect(fakes.serverInfo).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });

  it('offline, still tells what the service worker did, but leaves the server alone', async () => {
    connectivity.value = 'offline';
    const report: WorkerReport = {
      refused: [
        { kind: 'subscription.create', url: 'https://feeds.example', code: 'choose', message: '' },
        { kind: 'label.update', code: 'invalid', message: 'Too long' },
      ],
      overridden: 2,
      noteConflicts: [{ id: 1, mine: 'Here', theirs: 'There' }],
      themeDrafts: [{ name: 'Dusk' } as WorkerReport['themeDrafts'][number]],
      renumbered: true,
    };
    fakes.takeWorkerReport.mockResolvedValue(report);
    const { notices, queryClient } = setup();
    const invalidate = spyInvalidations(queryClient);
    await settle();
    expect(fakes.serverInfo).not.toHaveBeenCalled();
    const plain = notices().map((text) => text.replace(/[\u2066-\u2069]/g, ''));
    expect(plain[0]).toBe(
      'https://feeds.example offers several feeds; subscribe again to pick one.',
    );
    expect(plain[1]).toMatch(/^A change made offline couldn't be saved: /);
    expect(plain[2]).toMatch(/^The theme "Dusk" couldn't be saved/);
    expect(plain[3]).toMatch(/^2 changes made offline weren't applied/);
    expect(fakes.keepThemeDrafts).toHaveBeenCalledWith(h.db, report.themeDrafts);
    expect(invalidate.keys()).toEqual(
      ['subscriptions', 'categories', 'labels', 'themes', 'prefs', 'entries', 'entry'].map((k) => [
        k,
      ]),
    );
    expect(noteConflicts.value).toEqual(report.noteConflicts);
    expect(h.log).toEqual(['loadStatus', 'keepThemeDrafts', 'loadStatus']);
  });

  it('marks an older server unsupported, and asks again at the next sync', async () => {
    fakes.serverInfo.mockResolvedValue({ offline: false });
    setup();
    await settle();
    expect(syncStatus.unsupported).toBe(true);
    expect(fakes.syncStore).not.toHaveBeenCalled();
    syncRequests.value++;
    await settle();
    expect(fakes.serverInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps what a supporting server answered, and asks again after failing to reach it', async () => {
    fakes.serverInfo.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup();
    await settle();
    expect(syncStatus.unsupported).toBe(false);
    expect(fakes.syncStore).not.toHaveBeenCalled();
    syncRequests.value++;
    await settle();
    syncRequests.value++;
    await settle();
    expect(fakes.serverInfo).toHaveBeenCalledTimes(2);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);
  });

  it('sends kept changes only once the session is verified', async () => {
    sessionVerified.value = false;
    setup();
    await settle();
    expect(fakes.flushOutbox).not.toHaveBeenCalled();
    expect(fakes.syncStore).toHaveBeenCalledOnce();
    sessionVerified.value = true;
    await settle();
    expect(fakes.flushOutbox).toHaveBeenCalledOnce();
  });

  it('retries unsent changes, doubling the wait, or after the time the server asks', async () => {
    fakes.flushOutbox.mockResolvedValue(flushed({ stopped: 'unreachable' }));
    setup();
    await settle();
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(3);

    fakes.flushOutbox.mockResolvedValue(flushed({ stopped: { retryAfterSeconds: 30 } }));
    await vi.advanceTimersByTimeAsync(8000);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(4);
    fakes.flushOutbox.mockResolvedValue(flushed({ sent: 3 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fakes.flushOutbox).toHaveBeenCalledTimes(5);
  });

  it('refetches counters once kept changes are sent', async () => {
    fakes.flushOutbox.mockResolvedValue(flushed({ sent: 2 }));
    const { queryClient } = setup();
    const invalidate = spyInvalidations(queryClient);
    await settle();
    expect(invalidate.spy).toHaveBeenCalledWith({ queryKey: COUNTERS_KEY });
  });

  it('records why a sync failed', async () => {
    fakes.syncStore.mockRejectedValue(new ApiError(500, 'internal', 'Boom', null));
    setup();
    await settle();
    expect(syncStatus.lastError).toMatchObject({ kind: 'refused', status: 500 });
    expect(syncStatus.running).toBe(false);
    expect(syncStatus.lastSyncedAt).toBeNull();
    expect(h.log.at(-1)).toBe('saveStatus');
  });

  it('after filling the store, says when the browser had cleared it', async () => {
    fakes.syncStore.mockResolvedValue('bootstrap');
    fakes.wasEvicted.mockResolvedValue(true);
    const { notices } = setup();
    await settle();
    expect(fakes.markFilled).toHaveBeenCalled();
    expect(notices()).toEqual([
      'The browser cleared the articles kept on this device. They are being downloaded again.',
    ]);
  });

  it('shows synced changes in the lists, articles, and feeds on screen', async () => {
    fakes.syncStore.mockImplementation(
      ({ onChanges }: { onChanges: (c: SyncResponse) => void }) => {
        onChanges(
          changes({
            entries: [entry(1, { unread: false }), entry(2, { contentVersion: 'v2' })],
            subscriptions: [{ id: 5, title: 'New title' } as Subscription],
            deleted: { categories: [], subscriptions: [6], labels: [], entries: [] },
          }),
        );
        return Promise.resolve('changes');
      },
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData<InfiniteData<EntryListResponse>>(['entries', 'all'], {
      pages: [{ entries: [entry(1), entry(3)] } as EntryListResponse],
      pageParams: [null],
    });
    queryClient.setQueryData(['entry', 1], { ...entry(1), content: '<p>kept</p>' });
    queryClient.setQueryData(['entry', 2], entry(2));
    queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, [
      { id: 5, title: 'Old' } as Subscription,
      { id: 6, title: 'Gone' } as Subscription,
    ]);
    const invalidate = spyInvalidations(queryClient);
    withSetup(() => {
      useOfflineSync();
    }, queryClient);
    await settle();

    const list = queryClient.getQueryData<InfiniteData<EntryListResponse>>(['entries', 'all']);
    expect(list?.pages[0]?.entries.map((e) => [e.id, e.unread])).toEqual([
      [1, false],
      [3, true],
    ]);
    expect(queryClient.getQueryData(['entry', 1])).toMatchObject({
      unread: false,
      content: '<p>kept</p>',
    });
    expect(invalidate.spy).toHaveBeenCalledWith({ queryKey: ['entry', 2] });
    expect(queryClient.getQueryData(SUBSCRIPTIONS_KEY)).toEqual([{ id: 5, title: 'New title' }]);
  });

  it('syncs again once counters change and settle, not for their first reading', async () => {
    const { queryClient } = setup();
    await settle();
    let unread = 1;
    const fetchCounters = () =>
      queryClient.query({
        queryKey: COUNTERS_KEY,
        queryFn: () => Promise.resolve({ unread }),
        staleTime: 0,
      });
    await fetchCounters();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(1);

    unread = 2;
    await fetchCounters();
    await fetchCounters();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fakes.syncStore).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);

    queryClient.setQueryData(COUNTERS_KEY, { unread: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);
  });

  it('runs once more after a sync when asked while it ran', async () => {
    let finish!: () => void;
    fakes.syncStore.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve('changes');
          };
        }),
    );
    setup();
    await settle();
    syncRequests.value++;
    await settle();
    flushRequests.value++;
    await settle();
    expect(fakes.syncStore).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);
  });

  it('syncs every 15 minutes while visible; hidden, every 30 and only polling in the background', async () => {
    setup();
    await settle();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);

    // Hidden without polling in the background: no sync, and the next check is 30 minutes on.
    hidden = true;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);

    pollInBackground.value = true;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(3);
  });

  it('syncs when the server answers again and when the shell asks, until unmounted', async () => {
    connectivity.value = 'unreachable';
    const { wrapper } = setup();
    await settle();
    expect(fakes.syncStore).not.toHaveBeenCalled();
    connectivity.value = 'online';
    await settle();
    expect(fakes.syncStore).toHaveBeenCalledTimes(1);
    h.refresh?.();
    await settle();
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    expect(h.refresh).toBeNull();
    syncRequests.value++;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fakes.syncStore).toHaveBeenCalledTimes(2);
  });
});
