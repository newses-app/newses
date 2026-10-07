import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { WEB_CSP } from './web-csp.ts';

const NOT_SPA = /^\/(api|public|healthz)(\/|$)/;

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
    // Public pages set their own, stricter policy.
    if (
      String(reply.getHeader('content-type')).startsWith('text/html') &&
      !reply.hasHeader('content-security-policy')
    ) {
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
