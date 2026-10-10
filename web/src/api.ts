import { ApiError, createApiClient } from '@rss-reader/shared/client';
import { trackSlow } from './lib/slow-requests.ts';

/**
 * Same-origin client; the session cookie authenticates and the CSRF token is kept by the client.
 * Slow requests are tracked, so the app can say when the server is waking up.
 */
export const api = createApiClient({ fetch: trackSlow(globalThis.fetch.bind(globalThis)) });

export const isUnauthenticated = (error: unknown) =>
  error instanceof ApiError && error.status === 401;

export { ApiError };
