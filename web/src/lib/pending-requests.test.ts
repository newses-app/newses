import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loading, SHOW_AFTER_MS, trackLoading } from './pending-requests.ts';

/** A fetch whose responses settle when the test says so. */
function pendingFetch() {
  const settle: ((ok: boolean) => void)[] = [];
  const fetch = trackLoading(
    () =>
      new Promise<Response>((resolve, reject) => {
        settle.push((ok) => {
          if (ok) resolve(new Response('{}'));
          else reject(new TypeError('network'));
        });
      }),
  );
  return { fetch, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('trackLoading', () => {
  it('never shows requests that finish quickly', async () => {
    const { fetch, settle } = pendingFetch();
    const request = fetch('/a');
    settle[0]?.(true);
    await request;
    await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS);
    expect(loading.value).toBe(false);
  });

  it('shows a pending request until it settles, even when it fails', async () => {
    const { fetch, settle } = pendingFetch();
    const request = fetch('/a');
    await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS);
    expect(loading.value).toBe(true);
    settle[0]?.(false);
    await expect(request).rejects.toThrow('network');
    expect(loading.value).toBe(false);
  });

  it('keeps showing while any overlapping request is pending', async () => {
    const { fetch, settle } = pendingFetch();
    const first = fetch('/a');
    const second = fetch('/b');
    await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS);
    settle[0]?.(true);
    await first;
    expect(loading.value).toBe(true);
    settle[1]?.(true);
    await second;
    expect(loading.value).toBe(false);
  });
});
