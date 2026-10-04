import {
  categorySchema,
  createCategoryRequestSchema,
  opmlImportResultSchema,
  subscribeRequestSchema,
  subscribeResponseSchema,
  subscriptionSchema,
  updateCategoryRequestSchema,
  updateSubscriptionRequestSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FeedServices } from '../../core/feeds/index.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toCategory, toSubscription } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });
const OPML_TYPES = ['application/xml', 'text/xml', 'text/x-opml', 'application/x-opml'];

export const feedRoutes: FastifyPluginAsyncZod<FeedServices> = (
  app,
  { categories, subscriptions, opml },
) => {
  app.addHook('preHandler', requireUser);

  app.get(
    '/categories',
    { schema: { response: { 200: z.array(categorySchema) } } },
    async (request) => (await categories.list(requireAuth(request).user.id)).map(toCategory),
  );

  app.post(
    '/categories',
    { schema: { body: createCategoryRequestSchema, response: { 201: categorySchema } } },
    async (request, reply) => {
      const { title, parentId } = request.body;
      const row = await categories.create(requireAuth(request).user.id, title, parentId);
      return reply.code(201).send(toCategory(row));
    },
  );

  app.patch(
    '/categories/:id',
    {
      schema: {
        params: idParams,
        body: updateCategoryRequestSchema,
        response: { 200: categorySchema },
      },
    },
    async (request) => {
      const { title, parentId, sortOrder, collapsed } = request.body;
      const row = await categories.update(requireAuth(request).user.id, request.params.id, {
        ...(title !== undefined && { title }),
        ...(parentId !== undefined && { parentId }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(collapsed !== undefined && { collapsed }),
      });
      return toCategory(row);
    },
  );

  app.delete('/categories/:id', { schema: { params: idParams } }, async (request, reply) => {
    await categories.delete(requireAuth(request).user.id, request.params.id);
    return reply.code(204).send();
  });

  app.get(
    '/subscriptions',
    { schema: { response: { 200: z.array(subscriptionSchema) } } },
    async (request) => (await subscriptions.list(requireAuth(request).user.id)).map(toSubscription),
  );

  app.post(
    '/subscriptions',
    {
      schema: {
        body: subscribeRequestSchema,
        response: { 200: subscribeResponseSchema, 201: subscribeResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await subscriptions.subscribe(
        requireAuth(request).user.id,
        request.body.url,
        request.body.categoryId,
      );
      if (result.status === 'choose') return reply.code(200).send(result);
      return reply
        .code(201)
        .send({ status: 'subscribed', subscription: toSubscription(result.subscription) });
    },
  );

  app.patch(
    '/subscriptions/:id',
    {
      schema: {
        params: idParams,
        body: updateSubscriptionRequestSchema,
        response: { 200: subscriptionSchema },
      },
    },
    async (request) => {
      const { title, categoryId, sortOrder } = request.body;
      const view = await subscriptions.update(requireAuth(request).user.id, request.params.id, {
        ...(title !== undefined && { title }),
        ...(categoryId !== undefined && { categoryId }),
        ...(sortOrder !== undefined && { sortOrder }),
      });
      return toSubscription(view);
    },
  );

  app.delete('/subscriptions/:id', { schema: { params: idParams } }, async (request, reply) => {
    await subscriptions.unsubscribe(requireAuth(request).user.id, request.params.id);
    return reply.code(204).send();
  });

  app.register((plugin) => {
    const opmlApp = plugin.withTypeProvider<ZodTypeProvider>();
    opmlApp.addContentTypeParser(
      OPML_TYPES,
      { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 },
      (_req, body, done) => {
        done(null, body);
      },
    );

    opmlApp.post(
      '/opml',
      { schema: { body: z.string(), response: { 200: opmlImportResultSchema } } },
      async (request) => opml.import(requireAuth(request).user.id, request.body),
    );

    opmlApp.get('/opml', async (request, reply) => {
      const xml = await opml.export(requireAuth(request).user.id);
      return reply
        .type('text/x-opml; charset=utf-8')
        .header('content-disposition', 'attachment; filename="subscriptions.opml"')
        .send(xml);
    });
    return Promise.resolve();
  });

  return Promise.resolve();
};
