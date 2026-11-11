import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { COUNTERS_KEY, POLL_MS, useLiveCounters } from './useCounters.ts';
import { SESSION_KEY } from './useSession.ts';

const MARKER = '/changes/abc';
let markerText: string | null;
const asked: string[] = [];

function mounted(changesPath: string | undefined) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(SESSION_KEY, {
    user: { id: 1 },
    csrfToken: null,
    iconsPath: '/feed-icons/x',
    ...(changesPath && { changesPath }),
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = mount(
    defineComponent({
      setup() {
        useLiveCounters();
        return () => h('div');
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
  );
  const refetches = () =>
    invalidate.mock.calls.filter(
      ([filters]) => typeof filters === 'object' && filters.queryKey === COUNTERS_KEY,
    ).length;
  return { wrapper, refetches };
}

beforeEach(() => {
  vi.useFakeTimers();
  markerText = null;
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      asked.push(`${url} ${init?.cache ?? ''}`);
      return Promise.resolve(
        markerText === null ? new Response(null, { status: 403 }) : new Response(markerText),
      );
    }),
  );
  vi.stubGlobal(
    'EventSource',
    vi.fn(function () {
      return { addEventListener: () => undefined, close: () => undefined };
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveCounters with a change marker', () => {
  it('polls the marker, not the API, and refetches counters only when it changed', async () => {
    const { wrapper, refetches } = mounted(MARKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual([`${MARKER} no-cache`]);
    expect(EventSource).not.toHaveBeenCalled();

    // Nothing written yet, then unchanged: no refetch.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(refetches()).toBe(0);

    markerText = 'first';
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(refetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(refetches()).toBe(1);

    markerText = 'second';
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(refetches()).toBe(2);
    expect(asked).toHaveLength(5);
    wrapper.unmount();
  });

  it('opens the event stream where the server gives no marker', async () => {
    const { wrapper } = mounted(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(EventSource).toHaveBeenCalled();
    expect(asked).toEqual([]);
    wrapper.unmount();
  });
});
