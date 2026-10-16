import type { NetworkStatus } from '@newses/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webBridge } from '../platform/bridge.ts';

type Module = typeof import('./connectivity.ts');

/** A shell whose network and refreshes the test drives. */
function fakeBridge(initial: NetworkStatus) {
  let network: (status: NetworkStatus) => void = () => undefined;
  let refresh: () => void = () => undefined;
  return {
    bridge: {
      ...webBridge,
      getNetwork: () => Promise.resolve(initial),
      onNetworkChange: (listener: (status: NetworkStatus) => void) => {
        network = listener;
        return () => undefined;
      },
      onRefresh: (listener: () => void) => {
        refresh = listener;
        return () => undefined;
      },
    },
    setNetwork: (status: NetworkStatus) => {
      network(status);
    },
    resume: () => {
      refresh();
    },
  };
}

let module: Module;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  module = await import('./connectivity.ts');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connectivity', () => {
  it('follows requests: unreachable after a network failure, online after any answer', async () => {
    const shell = fakeBridge({ connected: true, wifi: true });
    await module.startConnectivity(shell.bridge, () => Promise.resolve());
    let answer: () => Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'));
    const fetch = module.trackConnectivity(() => answer());

    await expect(fetch('/api/v1/entries')).rejects.toThrow(TypeError);
    expect(module.connectivity.value).toBe('unreachable');
    answer = () => Promise.resolve(new Response(null, { status: 404 }));
    await fetch('/api/v1/entries');
    expect(module.connectivity.value).toBe('online');
    answer = () => Promise.resolve(new Response(null, { status: 503 }));
    await fetch('/api/v1/entries');
    expect(module.connectivity.value).toBe('unreachable');
  });

  it('times requests out', async () => {
    const shell = fakeBridge({ connected: true, wifi: null });
    await module.startConnectivity(shell.bridge, () => Promise.resolve());
    const fetch = module.trackConnectivity(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const pending = fetch('/api/v1/entries');
    const failed = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(module.REQUEST_TIMEOUT_MS);
    await failed;
    expect(module.connectivity.value).toBe('unreachable');
  });

  it('checks an unreachable server with back-off, at once on reconnect and resume', async () => {
    const shell = fakeBridge({ connected: true, wifi: null });
    let up = false;
    const fetch = module.trackConnectivity(() =>
      up ? Promise.resolve(new Response('{}')) : Promise.reject(new TypeError('Failed to fetch')),
    );
    const check = vi.fn(() => fetch('/api/v1/server'));
    await module.startConnectivity(shell.bridge, check);

    await expect(fetch('/api/v1/entries')).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);

    // No checks without a network; one as soon as it returns.
    shell.setNetwork({ connected: false, wifi: null });
    expect(module.connectivity.value).toBe('offline');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(2);
    shell.setNetwork({ connected: true, wifi: true });
    expect(check).toHaveBeenCalledTimes(3);
    expect(module.networkStatus.value.wifi).toBe(true);

    up = true;
    shell.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(module.connectivity.value).toBe('online');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('starts offline when the shell says there is no network', async () => {
    await module.startConnectivity(fakeBridge({ connected: false, wifi: null }).bridge, () =>
      Promise.resolve(),
    );
    expect(module.connectivity.value).toBe('offline');
  });
});
