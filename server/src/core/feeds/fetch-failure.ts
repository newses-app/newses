import type { ErrorDetail } from '@newses/shared';
import type { FetchError } from './http.ts';

/**
 * Says why a URL could not be fetched without echoing network errors, which would let users probe
 * hosts and ports through the server. The caller picks the error code.
 */
export function describeFetchFailure(
  url: string,
  err: FetchError,
): { message: string; detail: ErrorDetail } {
  switch (err.code) {
    case 'invalid_url':
      return {
        message: `Not a valid URL: ${url}`,
        detail: { reason: 'fetch_invalid_url', params: { url } },
      };
    case 'blocked_address':
      return {
        message: `${url} is on a private network`,
        detail: { reason: 'fetch_blocked_address', params: { url } },
      };
    case 'http_status': {
      const status = String(err.status);
      return {
        message: `${url} returned HTTP ${status}`,
        detail: { reason: 'fetch_http_status', params: { url, status } },
      };
    }
    case 'too_large':
      return {
        message: `${url} is too large`,
        detail: { reason: 'fetch_too_large', params: { url } },
      };
    case 'too_many_redirects':
      return {
        message: `${url} redirects too many times`,
        detail: { reason: 'fetch_too_many_redirects', params: { url } },
      };
    case 'timeout':
      return {
        message: `Could not connect to ${url}`,
        detail: { reason: 'fetch_timeout', params: { url } },
      };
    case 'network':
      return {
        message: `Could not connect to ${url}`,
        detail: { reason: 'fetch_network', params: { url } },
      };
    case 'host_blocked':
      return {
        message: 'The site asked to wait before more requests',
        detail: { reason: 'fetch_host_blocked' },
      };
  }
}
