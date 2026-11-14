// The app's own origin, app://newses: the bundled web build with its CSP, or in development the
// web app's Vite dev server.
import { pathToFileURL } from 'node:url';
import { net } from 'electron';
import { appFilePath } from './urls.ts';

export interface ServeOptions {
  /** The bundled web build. */
  webDir: string;
  /** Sent as a header too, so it covers what a `<meta>` cannot. */
  csp: string;
  /** `pnpm dev`: where the pages come from instead, still on the app origin. */
  devServer?: string | undefined;
}

/** The `app:` protocol's handler. */
export function serveApp({ webDir, csp, devServer }: ServeOptions) {
  return async (request: Request): Promise<Response> => {
    if (devServer) {
      const { pathname, search } = new URL(request.url);
      return net.fetch(`${devServer}${pathname}${search}`);
    }
    const file = appFilePath(webDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', csp);
      headers.set('x-content-type-options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
