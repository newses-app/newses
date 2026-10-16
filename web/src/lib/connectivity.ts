import type { NetworkStatus } from '@newses/shared';

/** `offline`: the device has no network; `unreachable`: it has one, but the server does not answer. */
export type Connectivity = 'online' | 'offline' | 'unreachable';

/** What one request says about the server; null when it says nothing (the caller aborted it). */
export type ServerState = 'reachable' | 'unreachable';

/** Answers a proxy or load balancer gives while the server is down, restarting, or deploying. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Classifies a request: a network failure (`TypeError`, which is also how the apps see a response
 * without CORS headers), a timeout, or a gateway error means unreachable; any other response,
 * errors included, means the server answered.
 */
export function requestOutcome(
  result: { response: Response } | { error: unknown },
): ServerState | null {
  if ('response' in result)
    return GATEWAY_STATUSES.has(result.response.status) ? 'unreachable' : 'reachable';
  const { error } = result;
  if (error instanceof TypeError) return 'unreachable';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'unreachable';
  return null;
}

export function connectivityOf(network: NetworkStatus, server: ServerState): Connectivity {
  if (!network.connected) return 'offline';
  return server === 'unreachable' ? 'unreachable' : 'online';
}

/** Checks of an unreachable server start after 5 s and back off to once a minute. */
export const probeDelay = (attempt: number) => Math.min(5000 * 2 ** attempt, 60_000);
