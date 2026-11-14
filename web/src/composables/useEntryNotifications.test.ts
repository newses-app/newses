import type { Category, Counters, DesktopOptions, Subscription } from '@newses/shared';
import { enableAutoUnmount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, type Ref } from 'vue';
import { bridge, desktop } from '../platform/index.ts';
import { withSetup } from '../test/mount.ts';
import { COUNTERS_KEY, pollInBackground } from './useCounters.ts';
import { NOTIFY_GAP_MS, useEntryNotifications } from './useEntryNotifications.ts';
import { CATEGORIES_KEY, SUBSCRIPTIONS_KEY } from './useFeeds.ts';

const notify = vi.hoisted(() =>
  vi.fn<(notification: { title: string; body: string; target: string }) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);
vi.mock('../platform/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../platform/index.ts')>();
  const { ref } = await import('vue');
  return {
    ...original,
    bridge: { ...original.bridge, platform: 'desktop', notify },
    desktop: { ...original.desktop, options: ref({ notifications: true }) },
  };
});
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { counters: () => new Promise(() => undefined) },
}));

enableAutoUnmount(afterEach);

const options = desktop.options as Ref<Partial<DesktopOptions> | null>;
const platform = bridge as { platform: string };

const counters = (...unread: number[]) =>
  ({ subscriptions: unread.map((n, i) => ({ id: i + 1, unread: n })) }) as Counters;

let focused: boolean;
let hidden: boolean;

function setup() {
  const mounted = withSetup(() => {
    useEntryNotifications();
  });
  const { queryClient } = mounted;
  queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, [
    { id: 1, title: 'Blog', categoryId: null } as Subscription,
    { id: 2, title: 'Paper', categoryId: 9 } as Subscription,
  ]);
  queryClient.setQueryData<Category[]>(CATEGORIES_KEY, [{ id: 9, title: 'News' } as Category]);
  const read = async (reading: Counters) => {
    queryClient.setQueryData(COUNTERS_KEY, reading);
    await nextTick();
  };
  return { ...mounted, read };
}

beforeEach(() => {
  vi.useFakeTimers();
  platform.platform = 'desktop';
  options.value = { notifications: true };
  pollInBackground.value = false;
  focused = true;
  hidden = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  notify.mockClear();
});

/** The isolates `t()` puts around parameters, left out. */
const plain = (text: string | undefined) => text?.replace(/[\u2066-\u2069]/g, '');

describe('useEntryNotifications', () => {
  it('polls counters in the background while notifications are on', async () => {
    setup();
    expect(pollInBackground.value).toBe(true);
    options.value = { notifications: false };
    await nextTick();
    expect(pollInBackground.value).toBe(false);
  });

  it('notifies of entries that arrive while away, then a running total at most every gap', async () => {
    const { read } = setup();
    await read(counters(0, 0));
    focused = false;
    await read(counters(2, 0));
    expect(notify).toHaveBeenCalledOnce();
    const [first] = notify.mock.calls[0] ?? [];
    expect(plain(first?.title)).toBe('2 new entries');
    expect(plain(first?.body)).toBe('Blog');
    expect(first?.target).toMatch(/1$/);

    await read(counters(3, 4));
    expect(notify).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(NOTIFY_GAP_MS);
    expect(notify).toHaveBeenCalledTimes(2);
    const [second] = notify.mock.calls[1] ?? [];
    expect(plain(second?.title)).toBe('7 new entries');
    expect(plain(second?.body)).toBe('News, Blog');
  });

  it('starts counting again once the reader is back', async () => {
    const { read } = setup();
    await read(counters(0));
    hidden = true;
    await read(counters(1));
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    hidden = true;
    await read(counters(2));
    await read(counters(3));
    expect(notify.mock.calls.map(([n]) => plain(n.title))).toEqual(['1 new entry', '1 new entry']);
  });

  it('never notifies while the window has focus, or with notifications off', async () => {
    const { read } = setup();
    await read(counters(0));
    await read(counters(5));
    options.value = { notifications: false };
    focused = false;
    await read(counters(9));
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing outside the desktop app', async () => {
    platform.platform = 'web';
    const { read } = setup();
    expect(pollInBackground.value).toBe(false);
    await read(counters(0));
    focused = false;
    await read(counters(5));
    expect(notify).not.toHaveBeenCalled();
  });
});
