import {
  bulkEntryStateRequestSchema,
  bulkEntryStateResponseSchema,
  countersSchema,
  entryContentsRequestSchema,
  entryContentsResponseSchema,
  entryListQuerySchema,
  entryListResponseSchema,
  entryNoteRequestSchema,
  entrySchema,
  entryStateRequestSchema,
  markReadRequestSchema,
  syncQuerySchema,
  syncResponseSchema,
  syncTokenResponseSchema,
  updatedCountSchema,
  fullTextResponseSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EntryServices } from '../../core/entries/index.ts';
import type { FullTextService } from '../../core/feeds/fulltext.ts';
import type { ImageProxy } from '../../core/feeds/images.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toCategory, toLabel, toSubscription } from '../dto.ts';
import { proxiedImages } from '../proxied-images.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const entryRoutes: FastifyPluginAsyncZod<
  EntryServices & { prefs: PrefsService; images: ImageProxy; fullText: FullTextService }
> = (app, { entries, counters, sync, prefs, images, fullText }) => {
  const withImages = proxiedImages(prefs, images);

  app.addHook('preHandler', requireUser);
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.get(
    '/entries',
    { schema: { querystring: entryListQuerySchema, response: { 200: entryListResponseSchema } } },
    async (request) => {
      const { subscriptionId, categoryId, labelId, tag, special, ...options } = request.query;
      const userId = requireAuth(request).user.id;
      const page = await entries.list(userId, {
        ...options,
        stream: { subscriptionId, categoryId, labelId, tag, special },
      });
      return { ...page, entries: await withImages(userId, page.entries) };
    },
  );

  app.get(
    '/entries/:id',
    { schema: { params: idParams, response: { 200: entrySchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const [entry] = await withImages(userId, [await entries.get(userId, request.params.id)]);
      return entry;
    },
  );

  app.post(
    '/entries/:id/full-text',
    { schema: { params: idParams, response: { 200: fullTextResponseSchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const content = await fullText.forUser(userId, request.params.id);
      const [result] = await withImages(userId, [{ fullContent: content }]);
      return { content: result?.fullContent ?? content };
    },
  );

  app.post(
    '/entries/contents',
    {
      schema: {
        body: entryContentsRequestSchema,
        response: { 200: entryContentsResponseSchema },
      },
    },
    async (request) => {
      const result = await entries.contents(requireAuth(request).user.id, request.body.ids);
      return {
        ...result,
        entries: result.entries.map((e) => {
          const content = e.content ?? null;
          const fullContent = e.fullContent ?? null;
          return {
            id: e.id,
            contentVersion: e.contentVersion,
            content,
            fullContent,
            enclosures: e.enclosures ?? [],
            // Signed whatever the user's proxy preference: stored images never reach image hosts.
            images: images.sources(`${content ?? ''}${fullContent ?? ''}`),
          };
        }),
      };
    },
  );

  app.patch(
    '/entries/:id',
    {
      schema: { params: idParams, body: entryStateRequestSchema, response: { 200: entrySchema } },
    },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const { expect, ...state } = request.body;
      if (expect) await entries.changeState(userId, [request.params.id], state, expect);
      else await entries.setState(userId, [request.params.id], state);
      const { content, enclosures, ...entry } = await entries.get(userId, request.params.id);
      return entry;
    },
  );

  app.put(
    '/entries/:id/note',
    { schema: { params: idParams, body: entryNoteRequestSchema } },
    async (request, reply) => {
      const { note, expected } = request.body;
      await entries.setNote(requireAuth(request).user.id, request.params.id, note, expected);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/entries',
    {
      schema: {
        body: bulkEntryStateRequestSchema,
        response: { 200: bulkEntryStateResponseSchema },
      },
    },
    async (request) => {
      const { ids, expect, ...state } = request.body;
      const userId = requireAuth(request).user.id;
      if (expect) return entries.changeState(userId, ids, state, expect);
      return { updated: await entries.setState(userId, ids, state) };
    },
  );

  app.post(
    '/entries/mark-read',
    { schema: { body: markReadRequestSchema, response: { 200: updatedCountSchema } } },
    async (request) => {
      const { subscriptionId, categoryId, labelId, tag, special, olderThanDays, maxId } =
        request.body;
      const updated = await entries.markRead(
        requireAuth(request).user.id,
        { subscriptionId, categoryId, labelId, tag, special },
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
        labels: result.labels.map(toLabel),
      };
    },
  );

  app.get(
    '/sync/token',
    { schema: { response: { 200: syncTokenResponseSchema } } },
    async (request) => {
      requireAuth(request);
      return { next: await sync.token() };
    },
  );

  return Promise.resolve();
};
