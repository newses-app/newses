import {
  archiveEntriesQuerySchema,
  archiveEntriesResponseSchema,
  archivedEntrySchema,
  entrySchema,
  entryStateSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ArchiveService } from '../../core/entries/archive.ts';
import type { ImageProxy } from '../../core/feeds/images.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { proxiedImages } from '../proxied-images.ts';

const keyParams = z.object({ key: z.string().min(1).max(4000) });

/** Past articles of the user's feeds, including the cold-storage archive. */
export const archiveRoutes: FastifyPluginAsyncZod<{
  archive: ArchiveService;
  prefs: PrefsService;
  images: ImageProxy;
}> = (app, { archive, prefs, images }) => {
  const withImages = proxiedImages(prefs, images);

  app.addHook('preHandler', requireUser);
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.get(
    '/archive/entries',
    {
      schema: {
        querystring: archiveEntriesQuerySchema,
        response: { 200: archiveEntriesResponseSchema },
      },
    },
    async (request) => archive.list(requireAuth(request).user.id, request.query),
  );

  app.get(
    '/archive/entries/:key',
    { schema: { params: keyParams, response: { 200: archivedEntrySchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const [entry] = await withImages(userId, [await archive.get(userId, request.params.key)]);
      return entry;
    },
  );

  app.post(
    '/archive/entries/:key/restore',
    { schema: { params: keyParams, body: entryStateSchema, response: { 200: entrySchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const { content, enclosures, ...entry } = await archive.restore(
        userId,
        request.params.key,
        request.body,
      );
      return entry;
    },
  );

  return Promise.resolve();
};
