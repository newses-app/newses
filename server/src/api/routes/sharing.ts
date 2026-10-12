import { entrySchema, publishedFeedResponseSchema, shareResponseSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AccessKeyService } from '../../core/entries/access-keys.ts';
import type { EntryService } from '../../core/entries/entries.ts';
import { requireAuth, requireUser } from '../auth.ts';

const idParams = z.object({ id: z.coerce.number().int() });

/** Share links and the published feed's key; the public side is in `public.ts`. */
export const sharingRoutes: FastifyPluginAsyncZod<{
  entries: EntryService;
  accessKeys: AccessKeyService;
}> = (app, { entries, accessKeys }) => {
  app.addHook('preHandler', requireUser);

  app.put(
    '/entries/:id/share',
    { schema: { params: idParams, response: { 200: shareResponseSchema } } },
    async (request) => ({
      shareId: await entries.share(requireAuth(request).user.id, request.params.id),
    }),
  );

  app.delete('/entries/:id/share', { schema: { params: idParams } }, async (request, reply) => {
    await entries.unshare(requireAuth(request).user.id, request.params.id);
    return reply.code(204).send();
  });

  app.get('/shares', { schema: { response: { 200: z.array(entrySchema) } } }, async (request) =>
    entries.listShared(requireAuth(request).user.id),
  );

  app.get(
    '/published-feed',
    { schema: { response: { 200: publishedFeedResponseSchema } } },
    async (request) => ({ key: await accessKeys.get(requireAuth(request).user.id, 'published') }),
  );

  app.post(
    '/published-feed/regenerate',
    { schema: { response: { 200: publishedFeedResponseSchema } } },
    async (request) => ({
      key: await accessKeys.regenerate(requireAuth(request).user.id, 'published'),
    }),
  );

  return Promise.resolve();
};
