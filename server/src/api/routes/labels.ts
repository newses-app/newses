import {
  createLabelRequestSchema,
  entryLabelsRequestSchema,
  labelSchema,
  updateLabelRequestSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LabelService } from '../../core/entries/labels.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toLabel } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const labelRoutes: FastifyPluginAsyncZod<{ labels: LabelService }> = (app, { labels }) => {
  app.addHook('preHandler', requireUser);

  app.get('/labels', { schema: { response: { 200: z.array(labelSchema) } } }, async (request) =>
    (await labels.list(requireAuth(request).user.id)).map(toLabel),
  );

  app.post(
    '/labels',
    { schema: { body: createLabelRequestSchema, response: { 201: labelSchema } } },
    async (request, reply) => {
      const row = await labels.create(requireAuth(request).user.id, request.body);
      return reply.code(201).send(toLabel(row));
    },
  );

  app.patch(
    '/labels/:id',
    {
      schema: {
        params: idParams,
        body: updateLabelRequestSchema,
        response: { 200: labelSchema },
      },
    },
    async (request) =>
      toLabel(await labels.update(requireAuth(request).user.id, request.params.id, request.body)),
  );

  app.delete('/labels/:id', { schema: { params: idParams } }, async (request, reply) => {
    await labels.delete(requireAuth(request).user.id, request.params.id);
    return reply.code(204).send();
  });

  app.put(
    '/entries/:id/labels',
    { schema: { params: idParams, body: entryLabelsRequestSchema } },
    async (request, reply) => {
      await labels.setEntryLabels(
        requireAuth(request).user.id,
        request.params.id,
        request.body.labelIds,
      );
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
};
