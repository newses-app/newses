import { extname, isAbsolute, relative, resolve } from 'node:path';

/** The app's own origin: a privileged standard scheme, so it behaves like an HTTPS origin. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'rss-reader';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * The bundled file an `app://rss-reader/...` request is for. Extensionless paths are the web app's
 * routes, so they get `index.html`. Null for other hosts and paths outside the bundle.
 */
export function appFilePath(webDir: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!extname(path)) return resolve(webDir, 'index.html');
  const file = resolve(webDir, `.${path}`);
  const inside = relative(webDir, file);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? file : null;
}

/** True for pages of the app itself, which may be navigated to. */
export const isAppUrl = (url: string) => url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);

/** The URL when it may open in the system browser (http and https only); else null. */
export function externalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** An HTTPS origin, as the connect screen chooses; else null. */
export function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}
