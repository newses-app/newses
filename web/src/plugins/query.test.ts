import { onlineManager, useQuery } from '@tanstack/vue-query';
import { ApiError } from '@newses/shared/client';
import { flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { connectivity } from '../test/connectivity.ts';
import { withSetup } from '../test/mount.ts';
import { queryClient } from './query.ts';

const router = vi.hoisted(() => ({
  currentRoute: { value: { name: 'reader', fullPath: '/c/2?unread=1' } },
  push: vi.fn(() => Promise.resolve()),
}));
const sessionEnded = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../router.ts', () => ({ router }));
vi.mock('../composables/useSession.ts', () => ({ sessionEnded }));
vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/connectivity.ts')),
}));

const expired = () => new ApiError(401, 'unauthenticated', 'Sign in', null);

/** Runs a query with the app's client until it settles. */
async function query(key: string, fn: () => Promise<unknown>) {
  const { result } = withSetup(() => useQuery({ queryKey: [key], queryFn: fn }), queryClient);
  await flushPromises();
  return result;
}

beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  connectivity.value = 'online';
  router.currentRoute.value = { name: 'reader', fullPath: '/c/2?unread=1' };
});

describe('queryClient', () => {
  it('signs out to the login page, coming back here after, once the session expires', async () => {
    queryClient.setQueryData(['other'], 1);
    await query('labels', () => Promise.reject(expired()));
    expect(queryClient.getQueryData(['other'])).toBeUndefined();
    expect(sessionEnded).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/c/2?unread=1' },
    });
  });

  it('leaves a missing session to the route guard, and the login page alone', async () => {
    await query('session', () => Promise.reject(expired()));
    router.currentRoute.value = { name: 'login', fullPath: '/login' };
    await query('labels', () => Promise.reject(expired()));
    await query('counters', () => Promise.reject(new ApiError(500, 'internal', 'Boom', null)));
    expect(router.push).not.toHaveBeenCalled();
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it('retries twice while the server is reachable, and never a refused session', async () => {
    vi.useFakeTimers();
    const failing = vi.fn(() => Promise.reject(new ApiError(503, 'unavailable', 'Later', null)));
    void query('counters', failing);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing).toHaveBeenCalledTimes(3);

    const refused = vi.fn(() => Promise.reject(expired()));
    void query('labels', refused);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refused).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('pauses queries while the server cannot be reached', async () => {
    expect(onlineManager.isOnline()).toBe(true);
    connectivity.value = 'unreachable';
    await nextTick();
    expect(onlineManager.isOnline()).toBe(false);
    connectivity.value = 'online';
    await nextTick();
    expect(onlineManager.isOnline()).toBe(true);
  });
});
