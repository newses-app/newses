import {
  filterApplyRequestSchema,
  filterApplyResponseSchema,
  filterOrderRequestSchema,
  filterRequestSchema,
  filterSchema,
  filterTestResponseSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EntryService } from '../../core/entries/entries.ts';
import type { FilterService } from '../../core/filters/filters.ts';
import { requireAuth, requireUser } from '../auth.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const filterRoutes: FastifyPluginAsyncZod<{
  filters: FilterService;
  entries: EntryService;
}> = (app, { filters, entries }) => {
  app.addHook('preHandler', requireUser);
  const userOf = (request: Parameters<typeof requireAuth>[0]) => requireAuth(request).user.id;

  app.get('/filters', { schema: { response: { 200: z.array(filterSchema) } } }, (request) =>
    filters.list(userOf(request)),
  );

  app.post(
    '/filters',
    { schema: { body: filterRequestSchema, response: { 201: filterSchema } } },
    async (request, reply) =>
      reply.code(201).send(await filters.create(userOf(request), request.body)),
  );

  app.put(
    '/filters/order',
    { schema: { body: filterOrderRequestSchema, response: { 200: z.array(filterSchema) } } },
    (request) => filters.reorder(userOf(request), request.body.filterIds),
  );

  app.put(
    '/filters/:id',
    { schema: { params: idParams, body: filterRequestSchema, response: { 200: filterSchema } } },
    (request) => filters.update(userOf(request), request.params.id, request.body),
  );

  app.delete('/filters/:id', { schema: { params: idParams } }, async (request, reply) => {
    await filters.delete(userOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/filters/test',
    { schema: { body: filterRequestSchema, response: { 200: filterTestResponseSchema } } },
    async (request) => {
      const userId = userOf(request);
      const { checked, matched, ids } = await filters.test(userId, request.body);
      return { checked, matched, matches: await entries.getMany(userId, ids) };
    },
  );

  app.post(
    '/filters/:id/apply',
    {
      schema: {
        params: idParams,
        body: filterApplyRequestSchema,
        response: { 200: filterApplyResponseSchema },
      },
    },
    (request) => filters.apply(userOf(request), request.params.id, request.body.cursor),
  );

  return Promise.resolve();
};
