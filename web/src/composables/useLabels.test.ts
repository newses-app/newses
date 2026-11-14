import type { Entry, EntryListResponse, Label } from '@newses/shared';
import type { InfiniteData } from '@tanstack/vue-query';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectivity } from '../test/connectivity.ts';
import { withSetup } from '../test/mount.ts';
import { spyInvalidations } from '../test/queries.ts';
import { LABELS_KEY, useLabelActions, useLabels } from './useLabels.ts';
import { sessionVerified } from './useSession.ts';

const api = vi.hoisted(() => ({
  labels: {
    list: vi.fn(() => Promise.resolve([{ id: 1, caption: 'Work' }])),
    create: vi.fn((body: object) => Promise.resolve({ id: 5, ...body })),
    update: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  },
}));
const store = vi.hoisted(() => ({
  db: null as object | null,
  labelled: [] as { labels: number[] }[],
}));

vi.mock('../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));
vi.mock('../offline/store.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentStore: () => store.db,
}));
vi.mock('../offline/outbox.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  queueChanges: () => Promise.resolve(),
}));
vi.mock('../offline/registration.ts', () => ({ requestOutboxSync: () => Promise.resolve() }));
vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/connectivity.ts')),
}));

const COLORS = { fgColor: '#000000', bgColor: '#ffffff' };
const label: Label = { id: 3, caption: 'Later', ...COLORS };
const entry = (id: number, labels: number[]) => ({ id, labels }) as Entry;

/** Offline, with a store whose entries `modify` changes in place. */
function offline() {
  connectivity.value = 'offline';
  store.labelled = [{ labels: [3, 4] }];
  store.db = {
    outbox: { count: () => Promise.resolve(0) },
    entries: {
      where: () => ({
        equals: () => ({
          modify: (change: (e: { labels: number[] }) => void) => {
            store.labelled.forEach(change);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
}

beforeEach(() => {
  connectivity.value = 'online';
  sessionVerified.value = true;
  store.db = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useLabels', () => {
  it("loads the user's labels", async () => {
    const { result } = withSetup(() => useLabels());
    await flushPromises();
    expect(result.data.value).toEqual([{ id: 1, caption: 'Work' }]);
  });
});

describe('useLabelActions', () => {
  it("creates a label, refreshing labels and counters, and returns the server's", async () => {
    const { result, queryClient } = withSetup(() => useLabelActions());
    const invalidate = spyInvalidations(queryClient);
    await expect(result.create({ caption: 'New', ...COLORS })).resolves.toEqual({
      id: 5,
      caption: 'New',
      ...COLORS,
    });
    expect(invalidate.keys()).toEqual([LABELS_KEY, ['counters']]);
  });

  it('offline, keeps a new label under a temporary id and shows it in the list', async () => {
    offline();
    const { result, queryClient } = withSetup(() => useLabelActions());
    queryClient.setQueryData(LABELS_KEY, [label]);
    const invalidate = spyInvalidations(queryClient);
    const made = await result.create({ caption: 'New', ...COLORS });
    expect(made.id).toBeLessThan(0);
    expect(made.caption).toBe('New');
    expect(api.labels.create).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<Label[]>(LABELS_KEY)?.map((l) => l.id)).toContain(made.id);
    expect(invalidate.spy).not.toHaveBeenCalled();
  });

  it('refreshes after an update only once it is sent', async () => {
    const { result, queryClient } = withSetup(() => useLabelActions());
    const invalidate = spyInvalidations(queryClient);
    await result.update(3, { caption: 'Soon' });
    expect(api.labels.update).toHaveBeenCalledWith(3, { caption: 'Soon' });
    expect(invalidate.keys()).toEqual([LABELS_KEY, ['counters']]);

    offline();
    invalidate.spy.mockClear();
    await result.update(3, { caption: 'Sooner' });
    expect(api.labels.update).toHaveBeenCalledOnce();
    expect(invalidate.spy).not.toHaveBeenCalled();
  });

  it('deletes a label, refetching what shows labels', async () => {
    const { result, queryClient } = withSetup(() => useLabelActions());
    const invalidate = spyInvalidations(queryClient);
    await result.remove(3);
    expect(api.labels.delete).toHaveBeenCalledWith(3);
    expect(invalidate.keys()).toEqual([LABELS_KEY, ['counters'], ['entries'], ['entry']]);
  });

  it('offline, takes a deleted label off cached and stored entries', async () => {
    offline();
    const { result, queryClient } = withSetup(() => useLabelActions());
    queryClient.setQueryData<InfiniteData<EntryListResponse>>(['entries', 'all'], {
      pages: [{ entries: [entry(1, [3]), entry(2, [4])] } as EntryListResponse],
      pageParams: [null],
    });
    queryClient.setQueryData(['entry', 1], entry(1, [3, 4]));
    await result.remove(3);
    expect(api.labels.delete).not.toHaveBeenCalled();
    const list = queryClient.getQueryData<InfiniteData<EntryListResponse>>(['entries', 'all']);
    expect(list?.pages[0]?.entries.map((e) => e.labels)).toEqual([[], [4]]);
    expect(queryClient.getQueryData<Entry>(['entry', 1])?.labels).toEqual([4]);
    expect(store.labelled).toEqual([{ labels: [4] }]);
  });
});
