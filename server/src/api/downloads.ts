import { basename } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { DOWNLOADS_CACHE, downloadsAsAttachment, downloadType } from '@newses/shared/release';
import { DOWNLOADS_CSP } from '@newses/shared/web-csp';

const withCharset = (type: string) =>
  /^(text\/|application\/json)/.test(type) && !/charset=/i.test(type)
    ? `${type}; charset=utf-8`
    : type;

/**
 * Serves the apps' downloads from `root` at `/downloads/`, as CloudFront does on AWS: the Docker
 * apps build writes them there (infra/src/release/publish-local.ts). Versioned folders are
 * immutable; the feeds, latest.json, and the page at the root are revalidated.
 */
export function registerDownloads(app: FastifyInstance, root: string): void {
  app.get('/downloads', { schema: { hide: true } }, (_request, reply) =>
    reply.redirect('/downloads/', 301),
  );
  void app.register(fastifyStatic, {
    root,
    prefix: '/downloads/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (reply, path) => {
      const name = basename(path);
      const relative = path.slice(root.length).replace(/^[/\\]+/, '');
      void reply.header(
        'cache-control',
        /[/\\]/.test(relative) ? DOWNLOADS_CACHE.versioned : DOWNLOADS_CACHE.latest,
      );
      const type = downloadType(name);
      // The release's text is UTF-8: a charset where CloudFront adds one on AWS.
      if (type) void reply.header('content-type', withCharset(type));
      if (downloadsAsAttachment(name)) {
        void reply.header('content-disposition', `attachment; filename="${name}"`);
      }
      // The page runs no scripts; the app's policy is for the SPA.
      if (name.endsWith('.html')) void reply.header('content-security-policy', DOWNLOADS_CSP);
      void reply.header('x-content-type-options', 'nosniff');
    },
  });
}
