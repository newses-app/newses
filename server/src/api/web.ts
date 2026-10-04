import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Content Security Policy for the SPA. Styles allow inline because Vuetify injects its theme;
 * feed images and media load from anywhere, but scripts only from this origin, and frames only
 * from the video hosts the sanitiser keeps.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src *',
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const NOT_SPA = /^\/(api|healthz)(\/|$)/;

/** Serves the built SPA from `root`, falling back to index.html for client-side routes. */
export function registerWeb(app: FastifyInstance, root: string): void {
  void app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders: (reply, path) => {
      // Vite fingerprints everything under assets/; the rest must be revalidated.
      void reply.header(
        'cache-control',
        path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    if (String(reply.getHeader('content-type')).startsWith('text/html')) {
      void reply
        .header('content-security-policy', WEB_CSP)
        .header('x-frame-options', 'DENY')
        // Feed images and links must not learn the reader's URLs.
        .header('referrer-policy', 'no-referrer');
    }
    done(null, payload);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if ((request.method === 'GET' || request.method === 'HEAD') && !NOT_SPA.test(path)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });
}
