import { createHash } from 'node:crypto';
import type { Entry, Prefs } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessKeyService } from '../../core/entries/access-keys.ts';
import type { EntryService } from '../../core/entries/entries.ts';
import { PUBLISHED_FEED_LENGTH, publishedFeedXml } from '../../core/entries/published-feed.ts';
import type { ImageProxy } from '../../core/feeds/images.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { messagesFor, ownerLocale, pageLocale } from '../../i18n.ts';
import { notFoundPage, PUBLIC_PAGE_CSP, sharedEntryPage } from '../public-page.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicRouteDeps {
  entries: EntryService;
  accessKeys: AccessKeyService;
  prefs: PrefsService;
  images: ImageProxy;
  /** Origin of public URLs, e.g. `https://reader.example`; null uses the request's. */
  publicUrl: string | null;
}

/** Unauthenticated pages: shared entries and published feeds, addressed by unguessable ids. */
export const publicRoutes: FastifyPluginAsyncZod<PublicRouteDeps> = (
  app,
  { entries, accessKeys, prefs, images, publicUrl },
) => {
  const origin = (request: FastifyRequest) => publicUrl ?? `${request.protocol}://${request.host}`;

  /** Owners with the image proxy on keep image hosts away from their readers too. */
  function withImages(owner: Prefs, list: Entry[], base: string): Entry[] {
    if (!owner.proxyImages) return list;
    return list.map((e) => (e.content ? { ...e, content: images.rewrite(e.content, base) } : e));
  }

  const html = (reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('content-security-policy', PUBLIC_PAGE_CSP)
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('x-robots-tag', 'noindex')
      .header('cache-control', 'no-cache')
      .header('vary', 'Accept-Language')
      .send(body);

  app.get(
    '/share/:id',
    {
      schema: { params: z.object({ id: z.string().max(100) }), hide: true },
      config: { logSecrets: ['id'] },
    },
    async (request, reply) => {
      const shared = UUID.test(request.params.id)
        ? await entries.getShared(request.params.id)
        : null;
      const accepted = request.headers['accept-language'];
      if (!shared) return html(reply, 404, notFoundPage(pageLocale(accepted)));
      const owner = await prefs.get(shared.userId);
      // Same-origin proxy paths need no origin.
      const [entry] = withImages(owner, [shared.entry], '');
      const locale = pageLocale(accepted, owner.language);
      return html(reply, 200, sharedEntryPage(entry ?? shared.entry, locale));
    },
  );

  app.get(
    '/feeds/:key',
    {
      schema: { params: z.object({ key: z.string().max(100) }), hide: true },
      config: { logSecrets: ['key'] },
    },
    async (request, reply) => {
      const userId = await accessKeys.resolve(request.params.key, 'published');
      void reply.header('x-robots-tag', 'noindex').header('cache-control', 'no-cache');
      if (userId === null)
        return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      const base = origin(request);
      const owner = await prefs.get(userId);
      const list = withImages(
        owner,
        await entries.listPublished(userId, PUBLISHED_FEED_LENGTH),
        base,
      );
      const xml = publishedFeedXml(list, messagesFor(ownerLocale(owner.language)), {
        site: `${base}/`,
        self: `${base}/public/feeds/${encodeURIComponent(request.params.key)}`,
      });
      // The build date changes on every request, so it is left out of the validator.
      const etag = `W/"${createHash('sha256')
        .update(xml.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, ''))
        .digest('base64url')
        .slice(0, 32)}"`;
      void reply.header('etag', etag);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('application/rss+xml; charset=utf-8').send(xml);
    },
  );

  return Promise.resolve();
};

/**
 * TTRSS's public URLs, kept working after an import: `public.php?op=rss&id=-2&key=…` (the
 * published feed) and `public.php?op=share&key=…` (a shared article) redirect to their pages here.
 */
export const legacyPublicRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/public.php',
    {
      schema: {
        querystring: z.object({
          op: z.string().optional(),
          id: z.string().optional(),
          key: z.string().max(100).optional(),
        }),
        hide: true,
      },
      config: { logSecrets: ['key'] },
    },
    (request, reply) => {
      const { op, id, key } = request.query;
      void reply.header('x-robots-tag', 'noindex');
      if (key && op === 'rss' && id === '-2')
        return reply.redirect(`/public/feeds/${encodeURIComponent(key)}`, 301);
      if (key && op === 'share' && UUID.test(key))
        return reply.redirect(`/public/share/${key.toLowerCase()}`, 301);
      return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    },
  );
  return Promise.resolve();
};
