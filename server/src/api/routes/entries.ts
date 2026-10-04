import {
  bulkEntryStateRequestSchema,
  countersSchema,
  entryListQuerySchema,
  entryListResponseSchema,
  entrySchema,
  entryStateSchema,
  markReadRequestSchema,
  syncQuerySchema,
  syncResponseSchema,
  updatedCountSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EntryServices } from '../../core/entries/index.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toCategory, toSubscription } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const entryRoutes: FastifyPluginAsyncZod<EntryServices> = (
  app,
  { entries, counters, sync },
) => {
  app.addHook('preHandler', requireUser);
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.get(
    '/entries',
    { schema: { querystring: entryListQuerySchema, response: { 200: entryListResponseSchema } } },
    async (request) => {
      const { subscriptionId, categoryId, special, ...options } = request.query;
      return entries.list(requireAuth(request).user.id, {
        ...options,
        stream: { subscriptionId, categoryId, special },
      });
    },
  );

  app.get(
    '/entries/:id',
    { schema: { params: idParams, response: { 200: entrySchema } } },
    async (request) => entries.get(requireAuth(request).user.id, request.params.id),
  );

  app.patch(
    '/entries/:id',
    { schema: { params: idParams, body: entryStateSchema, response: { 200: entrySchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      await entries.setState(userId, [request.params.id], request.body);
      const { content, enclosures, ...entry } = await entries.get(userId, request.params.id);
      return entry;
    },
  );

  app.patch(
    '/entries',
    { schema: { body: bulkEntryStateRequestSchema, response: { 200: updatedCountSchema } } },
    async (request) => {
      const { ids, ...state } = request.body;
      return { updated: await entries.setState(requireAuth(request).user.id, ids, state) };
    },
  );

  app.post(
    '/entries/mark-read',
    { schema: { body: markReadRequestSchema, response: { 200: updatedCountSchema } } },
    async (request) => {
      const { subscriptionId, categoryId, special, olderThanDays, maxId } = request.body;
      const updated = await entries.markRead(
        requireAuth(request).user.id,
        { subscriptionId, categoryId, special },
        { olderThanDays, maxId },
      );
      return { updated };
    },
  );

  app.get('/counters', { schema: { response: { 200: countersSchema } } }, async (request) =>
    counters.get(requireAuth(request).user.id),
  );

  app.get(
    '/sync',
    { schema: { querystring: syncQuerySchema, response: { 200: syncResponseSchema } } },
    async (request) => {
      const result = await sync.changes(
        requireAuth(request).user.id,
        request.query.since,
        request.query.limit,
      );
      return {
        ...result,
        categories: result.categories.map(toCategory),
        subscriptions: result.subscriptions.map(toSubscription),
      };
    },
  );

  return Promise.resolve();
};
