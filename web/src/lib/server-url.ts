import type { ServerInfo } from '@rss-reader/shared';
import { API_VERSION, createApiClient, PRODUCT_NAME } from '@rss-reader/shared/client';

/** The origin of an HTTPS address as typed, adding `https://` when no scheme is given; else null. */
export function normaliseServerUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

export type ServerCheck =
  | { status: 'ok' | 'older'; info: ServerInfo }
  | { status: 'unreachable' | 'notRssReader' | 'incompatible' };

/**
 * Whether `info` is an rss-reader server this app can use: another API major is incompatible; an
 * older minor may lack what the app needs.
 */
export function compatibility(
  info: unknown,
  required: { major: number; minor: number } = API_VERSION,
): ServerCheck {
  const server = info as Partial<ServerInfo> | null;
  if (server?.product !== PRODUCT_NAME || !server.apiVersion) return { status: 'notRssReader' };
  const { major, minor } = server.apiVersion;
  if (major !== required.major) return { status: 'incompatible' };
  return { status: minor < required.minor ? 'older' : 'ok', info: server as ServerInfo };
}

/** Asks `GET /server` at `origin`, without credentials. */
export async function checkServer(origin: string, fetch?: typeof globalThis.fetch) {
  const api = createApiClient({ baseUrl: origin, token: () => null, ...(fetch && { fetch }) });
  let info: unknown;
  try {
    info = await api.serverInfo();
  } catch {
    // Unreachable, not HTTPS, a CORS refusal, or a 404 from something else: all look the same.
    return { status: 'unreachable' } as const;
  }
  return compatibility(info);
}
