import { ApiError, createApiClient } from '@newses/shared/client';
import { trackSlow } from './lib/slow-requests.ts';
import { bridge, connection, NATIVE } from './platform/index.ts';

const fetch = trackSlow(globalThis.fetch.bind(globalThis));

/**
 * In the browser, a same-origin client: the session cookie authenticates and the client keeps the
 * CSRF token. In the apps, the chosen server with the bearer token. Slow requests are tracked, so
 * the app can say when the server is waking up.
 */
/** Tells the server which app is calling, for its activity statistics. */
const client = NATIVE ? (bridge.platform === 'android' ? 'mobile' : 'desktop') : 'web';

export const api = NATIVE
  ? createApiClient({
      baseUrl: () => connection.state.serverUrl ?? '',
      token: () => connection.state.token,
      client,
      fetch,
    })
  : createApiClient({ client, fetch });

export const isUnauthenticated = (error: unknown) =>
  error instanceof ApiError && error.status === 401;

export { ApiError };
