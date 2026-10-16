import { describe, expect, it } from 'vitest';
import { connectivityOf, probeDelay, requestOutcome } from './connectivity.ts';

describe('requestOutcome', () => {
  it('counts any answer from the server as reachable, gateway errors as not', () => {
    for (const status of [200, 204, 401, 404, 429, 500])
      expect(requestOutcome({ response: new Response(null, { status }) })).toBe('reachable');
    for (const status of [502, 503, 504])
      expect(requestOutcome({ response: new Response(null, { status }) })).toBe('unreachable');
  });

  it('counts network failures and timeouts as unreachable, not aborts by the caller', () => {
    expect(requestOutcome({ error: new TypeError('Failed to fetch') })).toBe('unreachable');
    expect(requestOutcome({ error: new DOMException('Timed out', 'TimeoutError') })).toBe(
      'unreachable',
    );
    expect(requestOutcome({ error: new DOMException('Aborted', 'AbortError') })).toBeNull();
    expect(requestOutcome({ error: new Error('other') })).toBeNull();
  });
});

describe('connectivityOf', () => {
  it('is offline without a network, whatever the server last did', () => {
    expect(connectivityOf({ connected: false, wifi: null }, 'reachable')).toBe('offline');
    expect(connectivityOf({ connected: false, wifi: null }, 'unreachable')).toBe('offline');
    expect(connectivityOf({ connected: true, wifi: true }, 'unreachable')).toBe('unreachable');
    expect(connectivityOf({ connected: true, wifi: false }, 'reachable')).toBe('online');
  });
});

describe('probeDelay', () => {
  it('backs off from 5 s to a minute', () => {
    expect([0, 1, 2, 3, 4, 10].map(probeDelay)).toEqual([
      5000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});
