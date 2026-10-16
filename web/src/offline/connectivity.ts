import type { NetworkStatus, PlatformBridge } from '@newses/shared';
import { computed, ref } from 'vue';
import {
  connectivityOf,
  probeDelay,
  requestOutcome,
  type ServerState,
} from '../lib/connectivity.ts';

/**
 * Longer than any request the server allows itself (Lambda's 29 s, the database's 30 s statements),
 * so only a server that will not answer runs into it.
 */
export const REQUEST_TIMEOUT_MS = 45_000;

const network = ref<NetworkStatus>({ connected: true, wifi: null });
const server = ref<ServerState>('reachable');

/** Whether the app can reach its server now. */
export const connectivity = computed(() => connectivityOf(network.value, server.value));

/** The device's network, for choices such as downloading images only on Wi-Fi. */
export const networkStatus = computed(() => network.value);

let probe: () => Promise<unknown> = () => Promise.resolve();
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;

/** Asks the server again now, while it is unreachable over a working network. */
export function checkNow(): void {
  clearTimeout(probeTimer);
  probeTimer = undefined;
  if (server.value !== 'unreachable' || !network.value.connected) return;
  // The probe's own outcome goes through `trackConnectivity`; failures schedule the next one.
  void probe().catch(() => undefined);
}

function report(state: ServerState): void {
  server.value = state;
  if (state === 'reachable') {
    attempts = 0;
    clearTimeout(probeTimer);
    probeTimer = undefined;
  } else {
    probeTimer ??= setTimeout(checkNow, probeDelay(attempts++));
  }
}

/** Wraps `fetch` so every request reports whether the server answered, and times out. */
export function trackConnectivity(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    // Until the response's headers arrive; reading a long body is not a sign of a dead server.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new DOMException('The server did not answer in time', 'TimeoutError'));
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(input, { ...init, signal: init?.signal ?? timeout.signal });
      const outcome = requestOutcome({ response });
      if (outcome) report(outcome);
      return response;
    } catch (error) {
      const outcome = requestOutcome({ error });
      if (outcome) report(outcome);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Follows the device's network through the shell, and checks an unreachable server with `check`
 * (a request that needs no session) when the network returns, the app resumes, and on a back-off.
 */
export async function startConnectivity(
  bridge: PlatformBridge,
  check: () => Promise<unknown>,
): Promise<void> {
  probe = check;
  const changed = (status: NetworkStatus) => {
    const reconnected = status.connected && !network.value.connected;
    network.value = status;
    if (reconnected) {
      attempts = 0;
      checkNow();
    }
  };
  bridge.onNetworkChange(changed);
  bridge.onRefresh(checkNow);
  changed(await bridge.getNetwork());
}
