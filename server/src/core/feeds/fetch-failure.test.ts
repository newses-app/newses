import { describe, expect, it } from 'vitest';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { describeFetchFailure } from './fetch-failure.ts';
import { fetchPage } from './fulltext.ts';
import { FetchError, type FetchErrorCode } from './http.ts';

const URL = 'https://site.example/page';
const CAUSE = 'connect ECONNREFUSED 10.0.0.5:5432';

describe('describeFetchFailure', () => {
  it.each<[FetchErrorCode, string, object | undefined]>([
    ['invalid_url', 'fetch_invalid_url', { url: URL }],
    ['blocked_address', 'fetch_blocked_address', { url: URL }],
    ['too_large', 'fetch_too_large', { url: URL }],
    ['too_many_redirects', 'fetch_too_many_redirects', { url: URL }],
    ['timeout', 'fetch_timeout', { url: URL }],
    ['network', 'fetch_network', { url: URL }],
    ['http_status', 'fetch_http_status', { url: URL, status: '503' }],
    ['host_blocked', 'fetch_host_blocked', undefined],
  ])('turns %s into %s without the network error', (code, reason, params) => {
    const { message, detail } = describeFetchFailure(
      URL,
      new FetchError(code, CAUSE, { status: 503 }),
    );
    expect(detail).toEqual({ reason, ...(params && { params }) });
    expect(message).not.toContain(CAUSE);
  });
});

describe('fetchPage', () => {
  it('reports a failed fetch as fetch_failed, whatever failed, without the network error', async () => {
    for (const code of ['network', 'blocked_address', 'host_blocked'] as const) {
      const fetcher = new FakeFetcher().set(URL, new FetchError(code, CAUSE));
      const failure = await fetchPage({ fetcher }, URL, 'page').catch((err: unknown) => err);
      expect(failure).toMatchObject({ code: 'fetch_failed', detail: { reason: `fetch_${code}` } });
      expect((failure as Error).message).not.toContain(CAUSE);
    }
  });
});
