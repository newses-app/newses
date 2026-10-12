import type { ServerInfo } from '@newses/shared';
import {
  API_VERSION,
  createApiClient,
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
} from '@newses/shared/client';

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
  | { status: 'unreachable' | 'notNewses' | 'incompatible' };

/**
 * Whether `info` is a Newses server this app can use: another API major is incompatible; an
 * older minor may lack what the app needs.
 */
export function compatibility(
  info: unknown,
  required: { major: number; minor: number } = API_VERSION,
): ServerCheck {
  const server = info as Partial<ServerInfo> | null;
  const product = server?.product;
  const known = product === PRODUCT_NAME || LEGACY_PRODUCT_NAMES.includes(product ?? '');
  if (!known || !server?.apiVersion) return { status: 'notNewses' };
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
