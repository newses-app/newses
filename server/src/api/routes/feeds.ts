import {
  categorySchema,
  createCategoryRequestSchema,
  opmlImportResultSchema,
  subscribeRequestSchema,
  subscribeResponseSchema,
  subscriptionSchema,
  updateAllCategoriesRequestSchema,
  updateCategoryRequestSchema,
  updateSubscriptionRequestSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FeedServices } from '../../core/feeds/index.ts';
import { sendIcon } from '../icons.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toCategory, toSubscription } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });
const OPML_TYPES = ['application/xml', 'text/xml', 'text/x-opml', 'application/x-opml'];

export const feedRoutes: FastifyPluginAsyncZod<FeedServices> = (
  app,
  { categories, subscriptions, opml, updater, favicons, fullText },
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
    '/categories',
    { schema: { body: updateAllCategoriesRequestSchema } },
    async (request, reply) => {
      await categories.setAllCollapsed(requireAuth(request).user.id, request.body.collapsed);
      return reply.code(204).send();
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
      const { title, categoryId, sortOrder, updateIntervalMinutes, purgeDays } = request.body;
      const userId = requireAuth(request).user.id;
      const before = await subscriptions.get(userId, request.params.id);
      const view = await subscriptions.update(userId, request.params.id, {
        ...(title !== undefined && { title }),
        ...(categoryId !== undefined && { categoryId }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(updateIntervalMinutes !== undefined && {
          updateIntervalSeconds: updateIntervalMinutes === null ? null : updateIntervalMinutes * 60,
        }),
        ...(purgeDays !== undefined && { purgeDays }),
        ...(request.body.fullText !== undefined && { fullText: request.body.fullText }),
      });
      // Turning full text on extracts the feed's newest entries too.
      if (view.subscription.fullText && !before.subscription.fullText)
        await fullText.queueFor(view.source.id);
      return toSubscription(view);
    },
  );

  app.post(
    '/subscriptions/:id/refresh',
    { schema: { params: idParams } },
    async (request, reply) => {
      await updater.refresh(requireAuth(request).user.id, request.params.id);
      return reply.code(202).send();
    },
  );

  app.get(
    '/favicons/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const icon = await favicons.getForUser(requireAuth(request).user.id, request.params.id);
      if (!icon) return reply.code(404).send({ error: 'not_found', message: 'No icon' });
      return sendIcon(reply, icon);
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
