import { ApiError, createApiClient } from '@rss-reader/shared/client';

/** Same-origin client; the session cookie authenticates and the CSRF token is kept by the client. */
export const api = createApiClient();

export const isUnauthenticated = (error: unknown) =>
  error instanceof ApiError && error.status === 401;

export { ApiError };
