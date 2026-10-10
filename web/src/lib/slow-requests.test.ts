import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slow, SLOW_MS, trackSlow } from './slow-requests.ts';

/** A fetch whose responses settle when the test says so. */
function pendingFetch() {
  const settle: ((ok: boolean) => void)[] = [];
  const fetch = trackSlow(
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

describe('trackSlow', () => {
  it('ignores requests that finish quickly', async () => {
    const { fetch, settle } = pendingFetch();
    const request = fetch('/a');
    settle[0]?.(true);
    await request;
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(slow.value).toBe(false);
  });

  it('reports a slow request until it settles, even when it fails', async () => {
    const { fetch, settle } = pendingFetch();
    const request = fetch('/a');
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(slow.value).toBe(true);
    settle[0]?.(false);
    await expect(request).rejects.toThrow('network');
    expect(slow.value).toBe(false);
  });

  it('stays slow while any overlapping slow request is pending', async () => {
    const { fetch, settle } = pendingFetch();
    const first = fetch('/a');
    const second = fetch('/b');
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    settle[0]?.(true);
    await first;
    expect(slow.value).toBe(true);
    settle[1]?.(true);
    await second;
    expect(slow.value).toBe(false);
  });
});
