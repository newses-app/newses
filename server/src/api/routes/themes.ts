import { createThemeRequestSchema, themeSchema, updateThemeRequestSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ThemeService } from '../../core/themes.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toTheme } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const themeRoutes: FastifyPluginAsyncZod<{ themes: ThemeService }> = (app, { themes }) => {
  app.addHook('preHandler', requireUser);

  app.get('/themes', { schema: { response: { 200: z.array(themeSchema) } } }, async (request) => {
    const userId = requireAuth(request).user.id;
    return (await themes.list(userId)).map((view) => toTheme(view, userId));
  });

  app.post(
    '/themes',
    { schema: { body: createThemeRequestSchema, response: { 201: themeSchema } } },
    async (request, reply) => {
      const userId = requireAuth(request).user.id;
      const view = await themes.create(userId, request.body);
      return reply.code(201).send(toTheme(view, userId));
    },
  );

  app.patch(
    '/themes/:id',
    {
      schema: { params: idParams, body: updateThemeRequestSchema, response: { 200: themeSchema } },
    },
    async (request) => {
      const userId = requireAuth(request).user.id;
      return toTheme(await themes.update(userId, request.params.id, request.body), userId);
    },
  );

  app.delete('/themes/:id', { schema: { params: idParams } }, async (request, reply) => {
    await themes.delete(requireAuth(request).user.id, request.params.id);
    return reply.code(204).send();
  });

  return Promise.resolve();
};
