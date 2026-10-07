import { entryTagsRequestSchema, tagCountSchema } from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TagService } from '../../core/entries/tags.ts';
import { requireAuth, requireUser } from '../auth.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const tagRoutes: FastifyPluginAsyncZod<{ tags: TagService }> = (app, { tags }) => {
  app.addHook('preHandler', requireUser);

  app.get('/tags', { schema: { response: { 200: z.array(tagCountSchema) } } }, async (request) =>
    tags.list(requireAuth(request).user.id),
  );

  app.put(
    '/entries/:id/tags',
    {
      schema: {
        params: idParams,
        body: entryTagsRequestSchema,
        response: { 200: entryTagsRequestSchema },
      },
    },
    async (request) => ({
      tags: await tags.setEntryTags(
        requireAuth(request).user.id,
        request.params.id,
        request.body.tags,
      ),
    }),
  );

  return Promise.resolve();
};
